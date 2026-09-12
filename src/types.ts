// --- config ---
export interface Profile {
  host: string;
  user: string;
  password: string;
  sshPort: number;               // default 22
  sourceFileCcsid: number;       // fallback ccsid for 65535 columns, default 37
  mapepireJar?: string;          // override jar path on the box (else the uploaded copy)
  readOnly: boolean;             // when true, upload and compile are refused (default false)
  blockedCl: string[];           // extra destructive CL verbs to block on compile, on top of the defaults
}

// --- reporting ---
export type LogLevel = "debug" | "info" | "notice" | "warning" | "error"; // the MCP spec has more, these are enough

// tool calls get a ToolReporter, everything else NOOP_REPORTER, so backend code reports unconditionally
export interface Reporter {
  step(message: string): void;                                // a new phase, e.g. "connecting to X"
  bar(message: string, current: number, total: number): void; // determinate progress, e.g. lines uploaded
  log(level: LogLevel, message: string): void;                // durable event for the client's log
}

export const NOOP_REPORTER: Reporter = { step: () => {}, bar: () => {}, log: () => {} };

// --- members ---
export interface MemberRef { library: string; sourceFile: string; member: string; }

export interface MemberMeta { type: string; ccsid: number; lineCount: number; lastChanged?: string; }

// --- search ---
export interface SearchOpts {
  library: string;
  sourceFile?: string;
  memberType?: string;
  searchTerm: string;
  caseSensitive?: boolean;
  maxResults?: number;           // default 200
}

export interface SearchMatch {
  library: string;
  sourceFile: string;
  member: string;
  type?: string;
  seqNbr?: number;
  line?: string;
}

export interface SearchResult { matches: SearchMatch[]; truncated: boolean; }

// --- library list ---
export type LibraryListAction = "add" | "remove" | "set_current" | "replace";

export interface LibraryListChange {
  library?: string;              // add / remove / set_current
  libraries?: string[];          // replace: the full user portion, in search order
  position?: "first" | "last";   // add: default last
  currentLibrary?: string;       // replace: also set the current library
}

export interface LibraryListEntry { portion: string; library: string; } // portion: SYSTEM | PRODUCT | CURRENT | USER

// --- compile ---
export interface CompileOpts {
  library: string;
  sourceFile: string;
  member: string;
  targetLibrary?: string;        // default *curlib
  objectName?: string;           // default = member
  command?: string;              // full CL override (skips the template)
  type?: string;                 // override detected member type
}

export interface CompileError { severity: number; line?: number; toLine?: number; msgId?: string; text: string; }

export interface CompileResult {
  command: string;
  success: boolean;
  listing: string;
  messages: string;              // joblog / escape messages
  errors: CompileError[];        // parsed from EVFEVENT (best-effort)
}
