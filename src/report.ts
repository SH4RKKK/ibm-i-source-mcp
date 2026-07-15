import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { LogLevel, Reporter } from "./types.js";

// The `extra` object McpServer hands every tool callback.
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// Where reports go. Injected so selfcheck can capture instead of notify.
// sendProgress is undefined when the client sent no progressToken; the
// reporter then falls back to info-level log notifications, so the steps
// stay visible in clients that never ask for progress.
export interface ReporterIO {
  sendProgress?: (progress: number, total: number | undefined, message: string) => void;
  sendLog: (level: LogLevel, message: string) => void;
}

const PROGRESS_GAP_MS = 150;  // throttle rapid bar() updates on the progress channel
const LOG_GAP_MS = 2000;      // throttle much harder when falling back to log notifications
const STALL_MS = 8000;        // silence before the watchdog says "still working"

const round2 = (n: number) => Math.round(n * 100) / 100;

// Per-tool-call reporter. It turns step()/bar() into MCP progress notifications
// whose values only ever increase (the spec requires that), throttles bursts,
// and runs a watchdog: when nothing has been reported for a while it repeats
// the last message with the elapsed time, so a stalled server is visible as
// "still working — connecting to X (24s elapsed)" instead of a silent hang.
export class ToolReporter implements Reporter {
  private value = 0;           // last progress value sent (monotonic)
  private base = 0;            // offset for the current bar() phase
  private lastSend = 0;
  private lastSaid: string;
  private startedAt = Date.now();
  private lastActivity = Date.now();
  private timer?: NodeJS.Timeout;
  private updates = 0;         // progress/step updates actually emitted
  readonly hasToken: boolean;  // did the client ask for progress at all?
  // The trail: what happened when, replayed under the stats footer so the
  // progression is readable in the result even when nothing was shown live.
  private trail: { t: number; msg: string }[] = [];
  private barSlot?: { t: number; msg: string };  // last bar state of the running phase

  constructor(private tool: string, private io: ReporterIO, private stallMs = STALL_MS) {
    this.lastSaid = tool;
    this.hasToken = !!io.sendProgress;
  }

  // A new phase. Always sent, and it anchors the base so a following bar()
  // phase continues counting upward from here.
  step(message: string): void {
    this.note(message);
    this.emit(message, undefined, undefined, true);
    this.base = this.value;
  }

  // Determinate progress within the current phase (throttled, but the final
  // update where current reaches total always goes out). The trail keeps only
  // the last bar state per phase, not every tick.
  bar(message: string, current: number, total: number): void {
    this.barSlot = { t: Date.now(), msg: `${message} (${current}/${total})` };
    this.emit(message, current, total);
  }

  log(level: LogLevel, message: string): void {
    this.note(level === "info" ? message : `${level}: ${message}`);
    this.lastActivity = Date.now();
    this.io.sendLog(level, message);
  }

  // Append a trail entry, flushing the pending bar state of the ending phase.
  private note(msg: string): void {
    if (this.barSlot) {
      this.trail.push(this.barSlot);
      this.barSlot = undefined;
    }
    this.trail.push({ t: Date.now(), msg });
  }

  // Start the stall watchdog. Kept separate from the constructor so tests can
  // exercise step/bar without timers.
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

  // Uniform error result for tools: log it, then hand the client a clean
  // isError response with the tool name in front.
  failResult(e: unknown): { isError: true; content: { type: "text"; text: string }[] } {
    const msg = e instanceof Error ? e.message : String(e);
    this.log("error", `${this.tool} failed: ${msg}`);
    return { isError: true, content: [{ type: "text", text: `${this.tool} failed: ${msg}\n\n${this.footer()}` }] };
  }

  // The stats footer appended to every tool result: one line of stats, then
  // the trail replaying what happened when. This is the progress story that
  // lands in the transcript even when the client renders no live progress at
  // all (the VS Code extension today).
  footer(): string {
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const head = this.hasToken
      ? `[${this.tool}: ${secs}s, ${this.updates} live progress update(s) streamed]`
      : `[${this.tool}: ${secs}s, the client sent no progressToken, ${this.updates} step(s) went to the MCP log instead]`;
    if (this.barSlot) {
      this.trail.push(this.barSlot);
      this.barSlot = undefined;
    }
    if (!this.trail.length) return head;
    let lines = this.trail.map((e) => `  ${(((e.t - this.startedAt) / 1000)).toFixed(1).padStart(5)}s  ${e.msg}`);
    const MAX = 14; // keep long trails readable: first phases, a gap marker, the finish
    if (lines.length > MAX) lines = [...lines.slice(0, 6), `         ... ${lines.length - 13} more ...`, ...lines.slice(-7)];
    return `${head}\n${lines.join("\n")}`;
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
    const tot = determinate ? Math.max(this.base + total!, value) : undefined;

    this.updates++;
    if (this.io.sendProgress) this.io.sendProgress(round2(value), tot === undefined ? undefined : round2(tot), message);
    else this.io.sendLog("info", message);
  }
}

// Build the real reporter for one tool call: progress notifications tied to the
// client's progressToken (when it sent one), log notifications through the MCP
// logging capability, and everything mirrored to stderr for local debugging.
export function makeReporter(mcp: McpServer, extra: ToolExtra, tool: string): ToolReporter {
  const token = extra._meta?.progressToken;
  const io: ReporterIO = {
    sendProgress:
      token === undefined
        ? undefined
        : (progress, total, message) => {
            console.error(`[ibm-i-source] ${tool}: ${message}`);
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), message },
              })
              .catch(() => {});
          },
    sendLog: (level, message) => {
      console.error(`[ibm-i-source] ${tool} ${level}: ${message}`);
      void mcp.server.sendLoggingMessage({ level, logger: tool, data: message }).catch(() => {});
    },
  };
  const reporter = new ToolReporter(tool, io).start();
  extra.signal.addEventListener("abort", () => reporter.dispose());
  return reporter;
}
