import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { LogLevel, Reporter } from "./types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// --- constants ---
const PROGRESS_GAP_MS = 150;  // throttle rapid bar() updates on the progress channel
const LOG_GAP_MS = 2000;      // throttle much harder when falling back to log notifications
const STALL_MS = 8000;        // silence before the watchdog says "still working"

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- reporter ---
// sendProgress is undefined when the client sent no progressToken, and the reporter falls back
// to info level log notifications so the steps stay visible in clients that never ask for progress.
export interface ReporterIO {
  sendProgress?: (progress: number, total: number | undefined, message: string) => void;
  sendLog: (level: LogLevel, message: string) => void;
}

export class ToolReporter implements Reporter {
  private value = 0;           // last progress value sent, monotonic
  private base = 0;            // where the current bar() phase starts counting from
  private lastSend = 0;
  private lastSaid: string;
  private startedAt = Date.now();
  private lastActivity = Date.now();
  private timer?: NodeJS.Timeout;

  constructor(private tool: string, private io: ReporterIO, private stallMs = STALL_MS) {
    this.lastSaid = tool;
  }

  // always sent, and it anchors the base so a following bar() phase counts upward from here
  step(message: string): void {
    this.emit(message, undefined, undefined, true);
    this.base = this.value;
  }

  bar(message: string, current: number, total: number): void {
    this.emit(message, current, total);
  }

  log(level: LogLevel, message: string): void {
    this.lastActivity = Date.now();
    this.io.sendLog(level, message);
  }

  // the stall watchdog, kept out of the constructor so tests can drive step/bar without timers
  start(): this {
    const tick = Math.min(2000, Math.max(50, Math.floor(this.stallMs / 4)));
    this.timer = setInterval(() => {
      if (Date.now() - this.lastActivity < this.stallMs) return;
      const said = this.lastSaid;
      const secs = Math.round((Date.now() - this.startedAt) / 1000);
      this.emit(`still working: ${said} (${secs}s elapsed)`, undefined, undefined, true);
      this.lastSaid = said; // nudges echo the real message, they never nest
    }, tick);
    this.timer.unref?.();
    return this;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  failResult(e: unknown): { isError: true; content: { type: "text"; text: string }[] } {
    const text = `${this.tool} failed: ${e instanceof Error ? e.message : String(e)}`;
    this.log("error", text);
    return { isError: true, content: [{ type: "text", text }] };
  }

  private emit(message: string, current?: number, total?: number, force = false): void {
    this.lastSaid = message;
    this.lastActivity = Date.now();
    const determinate = current !== undefined && total !== undefined;
    const final = determinate && current! >= total!;
    const gap = this.io.sendProgress ? PROGRESS_GAP_MS : LOG_GAP_MS;
    if (!force && !final && Date.now() - this.lastSend < gap) return;
    this.lastSend = Date.now();

    let value = determinate ? this.base + current! : this.value + 1;
    if (value <= this.value) value = this.value + 0.01; // the spec wants strictly increasing values
    this.value = value;
    if (this.io.sendProgress) this.io.sendProgress(round2(value), determinate ? round2(Math.max(this.base + total!, value)) : undefined, message);
    else this.io.sendLog("info", message);
  }
}

// --- wiring ---
export function makeReporter(mcp: McpServer, extra: ToolExtra, tool: string): ToolReporter {
  const token = extra._meta?.progressToken;
  const fire = (tag: string, message: string, send: () => Promise<unknown>) => {
    console.error(`[ibm-i-source] ${tool}${tag}: ${message}`); // stdout is the JSON-RPC channel
    void send().catch(() => {});
  };
  const io: ReporterIO = {
    sendProgress: token === undefined ? undefined : (progress, total, message) =>
      fire("", message, () => extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), message } })),
    sendLog: (level, message) => fire(` ${level}`, message, () => mcp.server.sendLoggingMessage({ level, logger: tool, data: message })),
  };
  const reporter = new ToolReporter(tool, io).start();
  extra.signal.addEventListener("abort", () => reporter.dispose());
  return reporter;
}
