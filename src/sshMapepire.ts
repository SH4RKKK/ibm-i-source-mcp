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

// The mapepire jar we ship and run on the box in --single mode, like Code for
// IBM i. No daemon, no open port: we speak the mapepire protocol over SSH.
const BUNDLED_JAR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "mapepire-server.jar");
const REMOTE_SUBDIR = ".ibm-i-source-mcp";
const REMOTE_JAR_NAME = "mapepire-server.jar";

// SHA-256 of the shipped jar, verified before upload/run so a tampered file is
// refused. Update when bumping the jar.
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

// SSH host keys, trust on first use: the first connect records the fingerprint,
// later ones must match or we refuse. IBMI_HOST_FINGERPRINT pins it and skips
// the file. Kept next to the install, since an MCP server's cwd is unreliable.
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
// Match ignoring an optional "SHA256:" prefix and padding; the base64 body stays case sensitive.
const normFp = (fp: string) => fp.trim().replace(/^sha256:/i, "").replace(/=+$/, "");
const fpEq = (a: string, b: string) => normFp(a) === normFp(b);

// A WebSocket shaped shim over the ssh2 exec stream. SQLJob only uses send/close
// and the message/error/close events. Responses are newline delimited JSON.
class StreamSocket extends EventEmitter {
  private buf = "";
  stderr = ""; // tail of the jar's stderr, for error messages
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
    // Keep jar logs off stdout, but hold the tail so a failed launch can report.
    stream.stderr?.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString("utf8")).slice(-4000); });
    stream.on("error", (e: Error) => this.emit("error", e));
    stream.on("close", (...a: unknown[]) => this.emit("close", ...a));
  }
  send(data: string): void { this.stream.write(data + "\n"); }
  close(): void { try { this.stream.end(); } catch { /* already gone */ } }
}

// JVM cold start on IBM i can be slow, so give the first handshake room.
const CONNECT_TIMEOUT_MS = 60000;

function sftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
}

// Upload the jar to $HOME/.ibm-i-source-mcp, replacing it only when the size
// differs so a newer bundled jar takes over.
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

// Open SSH, ensure the jar, spawn it --single, and return a connected SQLJob
// driving that stream. The SSH client is attached to the job for teardown.
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
                  `This can mean the box changed, or a man in the middle. If the change is expected, ` +
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
        // Verify the host key ourselves (ssh2 does not). Pin wins, else trust on first use.
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
    // Run the jar in single mode like Code for IBM i. The four QIBM_* vars turn
    // off PASE and Java stdio conversion so our UTF-8 JSON is not mangled to the
    // job CCSID. They are inline prefixes because IBM i sshd drops channel env vars.
    const cmd =
      `QIBM_JAVA_STDIO_CONVERT=N QIBM_PASE_DESCRIPTOR_STDIO=B QIBM_USE_DESCRIPTOR_STDIO=Y QIBM_MULTI_THREADED=Y ` +
      `java -Dos400.stdio.convert=N -jar ${jarPath} --single`;
    const stream = await new Promise<import("ssh2").ClientChannel>((res, rej) =>
      conn.exec(cmd, (e, s) => (e ? rej(e) : res(s))),
    );

    const socket = new StreamSocket(stream);
    const job = new SQLJob();
    // socket/responseEmitter/status are private in TS but plain fields at runtime.
    const j = job as any;
    j.options.naming = profile.naming;
    j.socket = socket;
    // Feed each response line into the job's emitter by id, like mapepire's channel.
    socket.on("message", (line: string) => {
      try {
        const m = JSON.parse(line);
        j.responseEmitter.emit(m.id, m);
      } catch {
        /* startup banner or non-JSON log line: ignore */
      }
    });
    // If the jar never starts, the stream closes before a response. Reject with
    // the stderr tail rather than hang.
    let closedEarly: (() => void) | undefined;
    const closedBeforeReady = new Promise<never>((_, rej) => {
      closedEarly = () => rej(new Error(`mapepire process exited before connecting${socket.stderr ? `: ${socket.stderr.trim()}` : ""}`));
      socket.once("close", closedEarly);
    });

    // Single mode connects as the SSH user, so no host/user/password, only JDBC
    // options. technique "tcp" matches Code for IBM i (cli breaks on CCSID 65535).
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
