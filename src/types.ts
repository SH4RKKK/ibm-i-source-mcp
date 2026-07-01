export interface Profile {
  host: string;
  user: string;
  password: string;
  mapepirePort: number;          // default 8076
  naming: "system" | "sql";      // default system
  allowSelfCert: boolean;        // accept mapepire self-signed cert
  sourceFileCcsid: number;       // fallback ccsid for 65535 columns, default 37
}

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

export interface MemberInfo {
  sourceFile: string;
  name: string;
  type: string;
  text: string;
  lines?: number;
}

export interface SourceFileInfo {
  name: string;
  text: string;
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

export interface SourceBackend {
  transport: "mapepire";
  readMember(ref: MemberRef): Promise<{ content: string; meta: MemberMeta }>;
  searchSource(opts: SearchOpts): Promise<SearchResult>;
  listSourceFiles(library: string): Promise<SourceFileInfo[]>;
  listMembers(library: string, sourceFile?: string, memberType?: string): Promise<MemberInfo[]>;
  writeMember(ref: MemberRef, content: string): Promise<{ warnings: string[] }>;
  compile(opts: CompileOpts): Promise<CompileResult>;
  close(): Promise<void>;
}
