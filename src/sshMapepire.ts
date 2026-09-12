import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import mapepire from "@ibm/mapepire-js";
import { NOOP_REPORTER, type Profile, type Reporter } from "./types.js";

const { SQLJob } = mapepire;
type Job = InstanceType<typeof SQLJob>;

// --- constants ---
const BUNDLED_JAR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "mapepire-server.jar");
const BUNDLED_JAR_VERSION = "2.3.5"; // vendor/mapepire-server.jar, bump with BUNDLED_JAR_SHA256 below
const BUNDLED_JAR_SHA256 = "41b1cfa67778ac204426f1dda0b51bd3f45fe3b89c91121d968660140acc0876";
const REMOTE_DIR = ".ibm-i-source-mcp";
const CONNECT_TIMEOUT_MS = 10_000;
const MAPEPIRE_TIMEOUT_MS = 60_000; // a cold jvm on IBM i can take most of a minute
// turns off PASE and Java stdio conversion so our UTF-8 JSON is not mangled to the job ccsid.
// Inline prefixes because IBM i sshd drops channel env vars.
const JAVA_ENV = "QIBM_JAVA_STDIO_CONVERT=N QIBM_PASE_DESCRIPTOR_STDIO=B QIBM_USE_DESCRIPTOR_STDIO=Y QIBM_MULTI_THREADED=Y";

// --- helpers ---
const mb = (n: number) => (n / 1048576).toFixed(1);
const beat = (fn: () => void, ms: number): NodeJS.Timeout => { const t = setInterval(fn, ms); t.unref?.(); return t; }; // unref: never hold the process open
const cb = <T>(f: (k: (e: any, v: T) => void) => void) => new Promise<T>((res, rej) => f((e, v) => (e ? rej(e) : res(v))));

let jarVerified = false;
function verifyBundledJar(): void {
  if (jarVerified) return;
  const got = createHash("sha256").update(readFileSync(BUNDLED_JAR)).digest("hex");
  if (got !== BUNDLED_JAR_SHA256) throw new Error(`bundled mapepire jar failed its integrity check (expected ${BUNDLED_JAR_SHA256.slice(0, 12)}…, got ${got.slice(0, 12)}…). Refusing to upload or run it.`);
  jarVerified = true;
}

// ssh2's structured `level` and errno first, the message regexes only as a fallback if it rewords.
function describeConnectError(e: Error, where: string, user: string, afterSecs: number): Error {
  const msg = e?.message || String(e);
  const code = (e as NodeJS.ErrnoException)?.code;
  const level = (e as any)?.level as string | undefined;
  if (level === "client-timeout" || /timed out/i.test(msg)) return new Error(`IBM i at ${where} is not reachable: no ssh answer within ${afterSecs}s. Check the host and port, the network or vpn, and that the ssh server runs (strtcpsvr server(*sshd)).`);
  if (code === "ECONNREFUSED") return new Error(`IBM i at ${where} refused the connection: the machine answered but nothing listens on that port. Is the ssh server started (strtcpsvr server(*sshd)) and is IBMI_SSH_PORT right?`);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new Error(`IBM i host not found: "${where}" does not resolve. Check IBMI_HOST for typos, and your dns or vpn.`);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new Error(`IBM i at ${where} is not reachable: no route to host (after ${afterSecs}s). Check the network or vpn.`);
  if (level === "client-authentication" || /authentication/i.test(msg)) return new Error(`reached ${where}, but sign-on failed for user ${user}. Check IBMI_USER and IBMI_PASSWORD, and that the profile is not disabled.`);
  return new Error(`cannot connect to ${where}: ${msg}`);
}

// --- socket ---
// A WebSocket shaped shim over the ssh2 exec stream: SQLJob uses only send/close and the
// message/error/close events. Responses are newline delimited JSON.
class StreamSocket extends EventEmitter {
  private buf = "";
  stderr = "";
  constructor(private stream: ClientChannel) {
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
    stream.stderr?.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString("utf8")).slice(-4000); });
    stream.on("error", (e: Error) => this.emit("error", e));
    stream.on("close", (...a: unknown[]) => this.emit("close", ...a));
  }
  send(data: string): void { this.stream.write(data + "\n"); }
  close(): void { try { this.stream.end(); } catch { /* already gone */ } }
  get tail(): string { return this.stderr ? `: ${this.stderr.trim()}` : ""; }
}

// --- connect ---
async function sshConnect(profile: Profile, hostKey: string, reporter: Reporter): Promise<Client> {
  const conn = new Client();
  const t0 = Date.now();
  const secs = () => Math.round((Date.now() - t0) / 1000);
  reporter.step(`connecting to ${hostKey} over ssh as ${profile.user}`);
  const hb = beat(() => reporter.step(`still trying to reach ${hostKey} (${secs()}s, gives up at ${CONNECT_TIMEOUT_MS / 1000}s)`), 3000);
  try {
    await new Promise<void>((res, rej) => {
      conn
        .on("ready", res)
        .on("error", (e) => rej(describeConnectError(e, hostKey, profile.user, secs())))
        .connect({ host: profile.host, port: profile.sshPort, username: profile.user, password: profile.password, keepaliveInterval: 15000, readyTimeout: CONNECT_TIMEOUT_MS });
    });
  } finally {
    clearInterval(hb);
  }
  return conn;
}

async function ensureJar(conn: Client, reporter: Reporter): Promise<string> {
  verifyBundledJar();
  const s = await cb<SFTPWrapper>((k) => conn.sftp(k));
  try {
    const dir = `${await cb<string>((k) => s.realpath(".", k))}/${REMOTE_DIR}`;
    const remote = `${dir}/mapepire-server.jar`;
    const localSize = (await stat(BUNDLED_JAR)).size;
    const remoteSize = await new Promise<number>((res) => s.stat(remote, (e, st) => res(e ? -1 : st.size)));
    if (remoteSize !== localSize) {
      reporter.log("info", `uploading mapepire-server.jar ${BUNDLED_JAR_VERSION} (${mb(localSize)} MB) to ${dir}, first run on this box or a jar update`);
      await cb<void>((k) => s.mkdir(dir, (e) => k(e && (e as any).code !== 4 ? e : null, undefined)));
      const step = (done: number, _chunk: number, total: number) => reporter.bar(`uploading mapepire-server.jar: ${mb(done)}/${mb(total)} MB`, done, total);
      await cb<void>((k) => s.fastPut(BUNDLED_JAR, remote, { step }, (e) => k(e, undefined)));
      reporter.step("mapepire-server.jar uploaded");
    }
    return remote;
  } finally {
    s.end();
  }
}

type ConnectReply = { success?: boolean; error?: string; id?: string };

// Races the connect reply against the jvm never answering and against the process dying first,
// either of which would otherwise hang until the box is rebooted.
async function handshake(j: any, socket: StreamSocket, hostKey: string, reporter: Reporter): Promise<ConnectReply> {
  // single mode connects as the ssh user, so no host/user/password, only jdbc options.
  // technique "tcp" matches Code for IBM i (cli breaks on ccsid 65535).
  const props = Object.keys(j.options).map((k) => `${k}=${j.options[k]}`).join(";") || undefined;
  const sent = j.send({ id: SQLJob.getNewUniqueId(), type: "connect", technique: "tcp", application: "ibm-i-source-mcp", props }) as Promise<ConnectReply>;

  let onClose!: () => void;
  const died = new Promise<never>((_, rej) => {
    onClose = () => rej(new Error(`mapepire process exited before connecting${socket.tail}`));
    socket.once("close", onClose);
  });
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`mapepire connect timed out after ${MAPEPIRE_TIMEOUT_MS}ms${socket.tail}`)), MAPEPIRE_TIMEOUT_MS); });

  const t0 = Date.now();
  const hb = beat(() => reporter.step(`waiting for mapepire to answer on ${hostKey} (${Math.round((Date.now() - t0) / 1000)}s, gives up at ${MAPEPIRE_TIMEOUT_MS / 1000}s)`), 5000);
  try {
    return await Promise.race([sent, timeout, died]);
  } finally {
    clearTimeout(timer!);
    clearInterval(hb);
    socket.off("close", onClose);
  }
}

export async function connectSshMapepire(profile: Profile, reporter: Reporter = NOOP_REPORTER): Promise<Job> {
  const hostKey = `${profile.host}:${profile.sshPort}`;
  const conn = await sshConnect(profile, hostKey, reporter);
  try {
    reporter.step(`ssh connected to ${hostKey}, checking the mapepire server jar`);
    const jarPath = profile.mapepireJar ?? (await ensureJar(conn, reporter));
    reporter.step(`starting mapepire (java) on ${hostKey}, a cold jvm can take up to a minute`);
    const cmd = `${JAVA_ENV} java -Dos400.stdio.convert=N -jar ${jarPath} --single`;
    const socket = new StreamSocket(await cb<ClientChannel>((k) => conn.exec(cmd, k)));

    const job = new SQLJob();
    const j = job as any; // socket/responseEmitter/options/status are private in TS, plain fields at runtime
    j.options.naming = "system"; // the jdbc driver would otherwise default to sql naming
    j.socket = socket;
    socket.on("message", (line: string) => {
      try { const m = JSON.parse(line); j.responseEmitter.emit(m.id, m); }
      catch { /* startup banner or a log line that is not json: ignore */ }
    });

    const resp = await handshake(j, socket, hostKey, reporter);
    if (resp?.success !== true) throw new Error(resp?.error || "mapepire connect failed");
    socket.on("close", () => { j.status = "ended"; });
    j.status = "ready";
    if (resp.id) j.id = resp.id;
    j._sshConn = conn;
    j._closed = new Promise<never>((_, rej) => socket.once("close", () => rej(new Error(`connection to ${profile.host} lost: the ssh session closed. The next call reconnects automatically.`))));
    j._closed.catch(() => {}); // observed on demand via raceJobClosed
    reporter.log("info", `connected to ${hostKey} as ${profile.user} (mapepire over ssh)`);
    reporter.step(`connected to ${hostKey}`);
    return job;
  } catch (e) {
    conn.end();
    throw e;
  }
}

// --- session ---
export function raceJobClosed<T>(job: Job, p: Promise<T>): Promise<T> {
  const closed = (job as any)._closed as Promise<never> | undefined;
  return closed ? Promise.race([p, closed]) : p;
}

export async function closeSshMapepire(job?: Job): Promise<void> {
  if (!job) return;
  const conn: Client | undefined = (job as any)._sshConn;
  await job.close?.().catch(() => {});
  conn?.end();
}
