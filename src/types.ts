export interface Profile {
  host: string;
  user: string;
  password: string;
  sshPort: number;               // default 22
  naming: "system" | "sql";      // default system
  sourceFileCcsid: number;       // fallback ccsid for 65535 columns, default 37
  mapepireJar?: string;          // override jar path on the box (else the uploaded copy)
  readOnly: boolean;             // when true, upload/compile are refused (default false)
  hostFingerprint?: string;      // pinned SSH host key fingerprint (SHA256:...); else trust-on-first-use
  blockedCl: string[];           // extra destructive CL verbs to block on compile, on top of the defaults
  connectTimeoutMs: number;      // give up on the ssh connect after this long (default 20000)
}

// MCP logging levels we use (the spec has more, these are enough here).
export type LogLevel = "debug" | "info" | "notice" | "warning" | "error";

// How a long operation tells the user what it is doing right now. Tool calls
// get a real reporter (MCP progress + logging notifications); everything else
// gets the no-op, so backend code can report unconditionally.
export interface Reporter {
  step(message: string): void;                                // a new phase, e.g. "connecting to X"
  bar(message: string, current: number, total: number): void; // determinate progress, e.g. lines uploaded
  log(level: LogLevel, message: string): void;                // durable event for the client's log
}

export const NOOP_REPORTER: Reporter = { step: () => {}, bar: () => {}, log: () => {} };

export interface MemberRef {
  library: string;
  sourceFile: string;
  member: string;
}

export interface MemberMeta {
  type: string;                  // rpgle, sqlrpgle, clle, ...
  ccsid: number;
  recordLength: number;
  lineCount: number;
  lastChanged?: string;
}

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
  matchedOn?: "name" | "text" | "code"; // why this member surfaced
  text?: string;                 // member TEXT description (context)
  seqNbr?: number;               // set for code matches
  line?: string;                 // the matching source line (code matches)
}

export type LibraryListAction = "add" | "remove" | "set_current" | "replace";

export interface LibraryListChange {
  library?: string;              // add / remove / set_current
  libraries?: string[];          // replace: the full user portion, in search order
  position?: "first" | "last";   // add: default last
  currentLibrary?: string;       // replace: also set the current library
}

export interface LibraryListEntry {
  portion: string;               // SYSTEM | PRODUCT | CURRENT | USER
  library: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export interface CompileOpts {
  library: string;
  sourceFile: string;
  member: string;
  targetLibrary?: string;        // default *curlib
  objectName?: string;           // default = member
  command?: string;              // full CL override (skips the template)
  type?: string;                 // override detected member type
}

export interface CompileError {
  severity: number;
  line?: number;
  toLine?: number;
  msgId?: string;
  text: string;
}

export interface CompileResult {
  command: string;
  success: boolean;
  listing: string;               // compiler spool listing
  messages: string;              // joblog / escape messages
  errors: CompileError[];        // parsed from EVFEVENT (best-effort)
}
