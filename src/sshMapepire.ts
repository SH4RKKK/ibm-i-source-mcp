import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";
import type { SFTPWrapper } from "ssh2";
import mapepire from "@ibm/mapepire-js";
import type { Profile } from "./types.js";

const { SQLJob } = mapepire;
type Job = InstanceType<typeof SQLJob>;

// The mapepire server jar we ship and run on the box in --single mode. This is
// exactly what Code for IBM i does: no daemon to install, no port to open, we
// speak the mapepire JSON protocol over an SSH exec channel as the SSH user.
const BUNDLED_JAR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "mapepire-server.jar");
const REMOTE_SUBDIR = ".ibm-i-source-mcp";
const REMOTE_JAR_NAME = "mapepire-server.jar";

// SHA-256 of the jar we ship (mapepire-server 2.3.5). We verify the bundled file
// against this before ever uploading or running it, so a tampered artifact is
// refused rather than executed on the box. Update this when bumping the jar.
const BUNDLED_JAR_SHA256 = "41b1cfa67778ac204426f1dda0b51bd3f45fe3b89c91121d968660140acc0876";
let jarVerified = false;
function verifyBundledJar(): void {
  if (jarVerified) return;
  const got = createHash("sha256").update(readFileSync(BUNDLED_JAR)).digest("hex");
  if (got !== BUNDLED_JAR_SHA256) {
    throw new Error(`bundled mapepire jar failed its integrity check (expected ${BUNDLED_JAR_SHA256.slice(0, 12)}…, got ${got.slice(0, 12)}…). Refusing to upload or run it.`);
  }
  jarVerified = true;
}

// SSH host keys, trust-on-first-use. The first connection to a host records its
// key fingerprint; later connections must match or we refuse (possible MITM).
// IBMI_HOST_FINGERPRINT pins it explicitly and skips the file entirely.
// Stored next to the install (not the process cwd, which is unpredictable for an
// MCP server) so it is always in the same, findable place.
const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const knownHostsPath = () => join(INSTALL_DIR, ".ibmi-known-hosts.json");
function loadKnownHosts(): Record<string, string> {
  try { return JSON.parse(readFileSync(knownHostsPath(), "utf8")); } catch { return {}; }
}
function saveKnownHost(key: string, fp: string): void {
  const all = loadKnownHosts();
  all[key] = fp;
  try { writeFileSync(knownHostsPath(), JSON.stringify(all, null, 2) + "\n"); } catch { /* best effort */ }
}
const hostFp = (key: Buffer) => "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
// Compare fingerprints forgivingly: an optional "SHA256:" prefix and any padding
// or surrounding whitespace should not matter. The base64 body stays case
// sensitive. So "SHA256:abc", "abc", and "abc==" all match the same key.
const normFp = (fp: string) => fp.trim().replace(/^sha256:/i, "").replace(/=+$/, "");
const fpEq = (a: string, b: string) => normFp(a) === normFp(b);

// A WebSocket-shaped shim over an ssh2 exec stream. mapepire-js's SQLJob only
// touches socket.send()/close() and the message/error/close events, so this is
// all it needs. Responses are newline-delimited JSON on the jar's stdout.
class StreamSocket extends EventEmitter {
  private buf = "";
  stderr = ""; // last bit of the jar's stderr, kept for error messages
  constructor(private stream: import("ssh2").ClientChannel) {
    super();
    stream.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.emit("message", line);
      }
    });
    // The jar logs to stderr; keep it off our stdout (which carries JSON-RPC),
    // but hold on to the tail so a failed launch has something to report.
    stream.stderr?.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString("utf8")).slice(-4000); });
    stream.on("error", (e: Error) => this.emit("error", e));
    stream.on("close", (...a: unknown[]) => this.emit("close", ...a));
  }
  send(data: string): void { this.stream.write(data + "\n"); }
  close(): void { try { this.stream.end(); } catch { /* already gone */ } }
}

// JVM cold start on IBM i can take a while, so give the first handshake room.
const CONNECT_TIMEOUT_MS = 60000;

function sftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
}

// Upload the bundled jar to $HOME/.ibm-i-source-mcp once. Size mismatch (or a
// missing file) triggers a re-upload, so a newer bundled jar replaces an old one.
async function ensureJar(conn: Client): Promise<string> {
  verifyBundledJar();
  const s = await sftp(conn);
  try {
    const home = await new Promise<string>((res, rej) => s.realpath(".", (e, p) => (e ? rej(e) : res(p))));
    const dir = `${home}/${REMOTE_SUBDIR}`;
    const remote = `${dir}/${REMOTE_JAR_NAME}`;
    const localSize = (await stat(BUNDLED_JAR)).size;
    const remoteSize = await new Promise<number>((res) => s.stat(remote, (e, st) => res(e ? -1 : st.size)));
    if (remoteSize !== localSize) {
      await new Promise<void>((res, rej) => s.mkdir(dir, (e) => (e && (e as any).code !== 4 ? rej(e) : res())));
      await new Promise<void>((res, rej) => s.fastPut(BUNDLED_JAR, remote, (e) => (e ? rej(e) : res())));
    }
    return remote;
  } finally {
    s.end();
  }
}

// Open an SSH connection, make sure the jar is present, spawn it in --single
// mode, and hand back a connected mapepire SQLJob driving that stream. The SSH
// Client is attached to the job so the caller can tear both down together.
export async function connectSshMapepire(profile: Profile): Promise<Job> {
  const conn = new Client();
  const hostKey = `${profile.host}:${profile.sshPort}`;
  const expected = profile.hostFingerprint || loadKnownHosts()[hostKey];
  let presented: string | undefined;
  let mismatch = false;
  let firstUse = false;

  await new Promise<void>((res, rej) => {
    conn
      .on("ready", res)
      .on("error", (e) =>
        rej(
          mismatch
            ? new Error(
                `SSH host key for ${hostKey} does not match the trusted fingerprint.\n` +
                  `  expected: ${expected}\n  got:      ${presented}\n` +
                  `This can mean the box changed, or a man-in-the-middle. If the change is expected, ` +
                  `update IBMI_HOST_FINGERPRINT or remove the entry from ${knownHostsPath()}.`,
              )
            : e,
        ),
      )
      .connect({
        host: profile.host,
        port: profile.sshPort,
        username: profile.user,
        password: profile.password,
        keepaliveInterval: 15000,
        // Verify the host key ourselves (ssh2 does not by default). Pinned value
        // wins; otherwise trust-on-first-use, recording the key for next time.
        hostVerifier: ((key: Buffer) => {
          presented = hostFp(key);
          if (expected) { mismatch = !fpEq(presented, expected); return !mismatch; }
          firstUse = true;
          return true;
        }) as unknown as (key: Buffer) => boolean,
      });
  });

  if (firstUse && presented) {
    saveKnownHost(hostKey, presented);
    console.error(`[ibm-i-source] trusting SSH host key for ${hostKey} on first use: ${presented}. Pin it with IBMI_HOST_FINGERPRINT to enforce.`);
  }

  try {
    const jarPath = profile.mapepireJar ?? (await ensureJar(conn));
    // Run the mapepire server in single mode, exactly the way Code for IBM i
    // does. The four QIBM_* env vars turn off every PASE and Java stdio
    // converter so our UTF-8 JSON reaches the server unmangled; without them
    // PASE transcodes the pipe to the job CCSID and the server sees garbage.
    // The env vars are inline VAR=value prefixes on purpose: IBM i sshd usually
    // drops channel env vars (AcceptEnv), so they must be part of the command.
    const cmd =
      `QIBM_JAVA_STDIO_CONVERT=N QIBM_PASE_DESCRIPTOR_STDIO=B QIBM_USE_DESCRIPTOR_STDIO=Y QIBM_MULTI_THREADED=Y ` +
      `java -Dos400.stdio.convert=N -jar ${jarPath} --single`;
    const stream = await new Promise<import("ssh2").ClientChannel>((res, rej) =>
      conn.exec(cmd, (e, s) => (e ? rej(e) : res(s))),
    );

    const socket = new StreamSocket(stream);
    const job = new SQLJob();
    // socket/responseEmitter/status are private to SQLJob at the type level but
    // plain fields at runtime; reach them through an untyped alias.
    const j = job as any;
    j.options.naming = profile.naming;
    j.socket = socket;
    // Route every response line into the job's own emitter, keyed by message id,
    // exactly the way mapepire-js's WebSocket channel does.
    socket.on("message", (line: string) => {
      try {
        const m = JSON.parse(line);
        j.responseEmitter.emit(m.id, m);
      } catch {
        /* startup banner or non-JSON log line: ignore */
      }
    });
    // If the jar never starts (bad java, missing jar), the exec stream closes
    // before we get a response. Turn that into a clear rejection instead of a
    // hang, and surface whatever the jar printed to stderr.
    let closedEarly: (() => void) | undefined;
    const closedBeforeReady = new Promise<never>((_, rej) => {
      closedEarly = () => rej(new Error(`mapepire process exited before connecting${socket.stderr ? `: ${socket.stderr.trim()}` : ""}`));
      socket.once("close", closedEarly);
    });

    // In --single mode the connection is implicitly the SSH user, so the connect
    // message carries no host/user/password, only the JDBC options (naming, ...).
    // technique is "tcp" to match Code for IBM i: its "cli" mode has known issues
    // with DOVE and CCSID 65535 source, and tcp gives a normal QZDASOINIT job.
    const props = Object.keys(j.options)
      .map((k) => `${k}=${j.options[k]}`)
      .join(";");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`mapepire connect timed out after ${CONNECT_TIMEOUT_MS}ms${socket.stderr ? `: ${socket.stderr.trim()}` : ""}`)), CONNECT_TIMEOUT_MS);
    });
    const handshake = j.send({
      id: SQLJob.getNewUniqueId(),
      type: "connect",
      technique: "tcp",
      application: "ibm-i-source-mcp",
      props: props.length > 0 ? props : undefined,
    }) as Promise<{ success?: boolean; error?: string; id?: string }>;

    let resp: { success?: boolean; error?: string; id?: string };
    try {
      resp = await Promise.race([handshake, timeout, closedBeforeReady]);
    } finally {
      clearTimeout(timer);
      if (closedEarly) socket.removeListener("close", closedEarly);
    }
    if (resp?.success !== true) throw new Error(resp?.error || "mapepire connect failed");
    socket.on("close", () => { j.status = "ended"; });
    j.status = "ready";
    if (resp.id) j.id = resp.id;

    (job as any)._sshConn = conn;
    return job;
  } catch (e) {
    conn.end();
    throw e;
  }
}

// Tear down the mapepire job and the SSH connection behind it.
export async function closeSshMapepire(job?: Job): Promise<void> {
  if (!job) return;
  const conn: Client | undefined = (job as any)._sshConn;
  await job.close?.().catch(() => {});
  conn?.end();
}
