import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemberRef, SqlColumn, SqlRef } from "./types.js";

// --- source types ---
export function extFor(type: string): string {
  const t = type?.toLowerCase().trim();
  return t ? `.${t}` : ".txt";
}

const NOT_A_SOURCE_TYPE = /^(TXT|BAK|ORIG|TMP|TEMP|SAVE|SAVED|SWP|OLD|NEW|COPY)$/;
export function typeFromPath(path: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toUpperCase();
  return !ext || NOT_A_SOURCE_TYPE.test(ext) ? undefined : ext;
}

// --- sql escaping ---
// a term as an upper cased literal for like '%...%' escape '\', with %, _ and \ escaped
export function likeLiteral(term: string): string {
  return term.replace(/'/g, "''").replace(/[\\%_]/g, "\\$&").toUpperCase();
}

// --- run_sql guard ---
const SELECT_START = /^[(\s]*(?:select|with)\b/i;
const WRITES = /\b(?:insert\s+into|delete\s+from|merge\s+into|update\s+\S+\s+set|(?:final|new|old)\s+table\s*\()/i;
// system functions that run CL, call out of the box, or read IFS files
const REFUSED_FN = /\b(qcmdexc|http[a-z_]*|ifs_[a-z_]*)\s*\(/i;
// system services that return the contents of data rather than its description
const DATA = /\b(display_journal\w*|get_[a-z]*_from_file|spooled_file_data|data_queue_entries|receive_data_queue|data_area_info)\b/i;
const RUNAWAY = /\bsyspartitionindex(?:stat|es)\b/i;
export const SYSTEM_SCHEMAS = ["QSYS", "QSYS2", "SYSIBM", "SYSIBMADM", "SYSTOOLS"];

export function assertSelectOnly(statement: string): string {
  const sql = statement.trim().replace(/;\s*$/, "");
  if (!sql) throw new Error("empty sql statement");
  if (/--|\/\*/.test(sql)) throw new Error("remove the comments (-- and /* */), run_sql refuses a statement carrying any");
  if (sql.includes(";")) throw new Error(`run_sql takes one statement, remove the ";"`);
  if (!SELECT_START.test(sql)) throw new Error(`run_sql only runs select, "${sql.replace(/^[(\s]+/, "").split(/[\s(]+/)[0].toLowerCase()}" is not one`);
  if (WRITES.test(sql)) throw new Error("refusing a write inside a select");
  const fn = REFUSED_FN.exec(sql);
  if (fn) throw new Error(`refusing to call ${fn[1].toLowerCase()}() from run_sql`);
  const data = DATA.exec(sql);
  if (data) throw new Error(`refusing ${data[1].toLowerCase()}, it returns the contents of data and run_sql only reads system information`);
  const slow = RUNAWAY.exec(sql);
  if (slow) throw new Error(`refusing ${slow[0].toLowerCase()}, it can run for minutes and nothing stops it once it starts. Use qsys.qadbkfld for the key fields of a file, and systools.related_objects for the logical files over one`);
  return sql;
}

// checks the object references qsys2.parse_statement reports for a statement
export function assertSystemOnly(refs: SqlRef[]): void {
  if (!refs.length) throw new Error("could not tell what this select reads, so run_sql refuses it");
  const schemas = SYSTEM_SCHEMAS.join(", ");
  for (const r of refs) {
    if (r.statement !== "QUERY") throw new Error(`refusing a ${r.statement.toLowerCase()} statement, run_sql only reads`);
    if (r.type === "COLUMN") continue;
    if (r.usage !== "QUERY") throw new Error(`refusing ${r.name}, it is used as a ${r.usage.toLowerCase()} and run_sql only reads`);
    // unqualified functions are the built ins, such as rtrim and count
    if (r.type === "FUNCTION" && !r.schema) continue;
    if (!r.schema) throw new Error(`qualify ${r.name} with its schema, run_sql only reads system information in ${schemas}`);
    if (!SYSTEM_SCHEMAS.includes(r.schema)) throw new Error(`refusing ${r.schema}.${r.name}, run_sql only reads system information in ${schemas}, never the rows of a user table`);
  }
}

export function withTimeLimit<T>(work: Promise<T>, ms: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error(message)); }, ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

// --- fndstrpdm listing ---
// the hits in a fndstrpdm spool listing, as member, sequence number and line
export function parseFndstrpdm(lines: string[], known: Set<string>, needle: string): { member: string; seqNbr: number; line: string }[] {
  const out: { member: string; seqNbr: number; line: string }[] = [];
  const mark = needle.trim().toUpperCase();
  let member = "", named = false, fresh = false;
  let from = 12, to = 112;
  for (const raw of lines) {
    const seq = /^(\s*)(\d+) {2}/.exec(raw);
    if (seq && seq[1].length + seq[2].length <= 10) {
      if (member) out.push({ member, seqNbr: Number(seq[2]) / 100, line: raw.slice(from, to).trimEnd() });
      continue;
    }
    if (raw.startsWith(" ")) {
      if (raw.trim().toUpperCase() === mark) continue;
      const ruler = /\*[.+\d]{8,}/.exec(raw);
      if (ruler) { from = ruler.index; to = ruler.index + ruler[0].length; fresh = true; }
      continue;
    }
    // a heading after a ruler starts a new block with no member yet
    if (fresh) { member = ""; named = false; fresh = false; }
    // only the first known name in a block is the member
    if (named) continue;
    const value = raw.split(":")[1]?.trim().split(/\s+/)[0]?.toUpperCase();
    if (value && known.has(value)) { member = value; named = true; }
  }
  return out;
}

// --- local files ---
// writes UTF-8 without a BOM, with CRLF line ends, to the tree and to a copy under .backup
export function writeLocalCopy(baseDir: string, ref: MemberRef, type: string, content: string): { path: string; backup: string } {
  const name = ref.member + extFor(type);
  const crlf = content.replace(/\r?\n/g, "\r\n");
  const write = (p: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, crlf, "utf8"); return p; };
  const path = write(join(baseDir, ref.library, ref.sourceFile, name));
  const backup = write(join(baseDir, ".backup", ref.library, ref.sourceFile, name));
  return { path, backup };
}

// the copy read_source_member wrote, whatever extension it picked
export function findLocalCopy(baseDir: string, ref: MemberRef): string {
  const dir = join(baseDir, ref.library, ref.sourceFile);
  const hit = readdirSync(dir).find((f) => f.replace(/\.[^.]*$/, "") === ref.member);
  if (!hit) throw new Error(`no local copy in ${dir} for ${ref.member}, read it first or pass localPath/content`);
  return join(dir, hit);
}

export function writeSqlFile(baseDir: string, json: string): string {
  const path = join(baseDir, "sql", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, "utf8");
  return path;
}

// --- sql results ---
const CELL_MAX = 60;
const NUMERIC = /INT|DEC|NUM|DOUBLE|REAL|FLOAT/i;

export function textTable(columns: SqlColumn[], rows: Record<string, unknown>[]): string {
  if (!columns.length) return "(no columns)";
  const cell = (v: unknown) => {
    if (v == null) return "-";
    const s = String(v).replace(/\s+/g, " ").trim();
    return s.length > CELL_MAX ? s.slice(0, CELL_MAX - 1) + "…" : s;
  };
  const head = [columns.map((c) => c.name), columns.map((c) => `${c.type}(${c.precision}${c.scale ? `,${c.scale}` : ""})`)];
  const body = rows.map((r) => columns.map((c) => cell(r[c.name])));
  const num = columns.map((c) => NUMERIC.test(c.type));
  const width = columns.map((_, i) => [...head, ...body].reduce((w, r) => Math.max(w, r[i].length), 0));
  const line = (vals: string[]) => vals.map((v, i) => (num[i] ? v.padStart(width[i]) : v.padEnd(width[i]))).join("  ").trimEnd();
  return [...head.map(line), width.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

export function sqlJson(columns: SqlColumn[], rows: Record<string, unknown>[]): string {
  return `{"columns":${JSON.stringify(columns)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
}
