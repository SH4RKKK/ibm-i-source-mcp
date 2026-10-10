import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemberRef, SqlColumn } from "./types.js";

// --- source types ---
// the source type lowercased, like Code for IBM i, so editors pick the right handler
export function extFor(type: string): string {
  const t = type?.toLowerCase().trim();
  return t ? `.${t}` : ".txt";
}

// inverse of extFor. These never reach addpfm as a srctype: TXT is what extFor emits for a member
// with no type, and the rest are editor leftovers, so MYPGM.rpgle.bak would otherwise create a
// member of srctype BAK. Returning undefined forces the caller to pass memberType.
const NOT_A_SOURCE_TYPE = /^(TXT|BAK|ORIG|TMP|TEMP|SAVE|SAVED|SWP|OLD|NEW|COPY)$/;
export function typeFromPath(path: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toUpperCase();
  return !ext || NOT_A_SOURCE_TYPE.test(ext) ? undefined : ext;
}

// --- sql escaping ---
// for a `like '%...%' escape '\'` we build. Upper cased because the column is compared upper
// cased, and % and _ are escaped so a filter is a substring rather than a pattern.
export function likeLiteral(term: string): string {
  return term.replace(/'/g, "''").replace(/[\\%_]/g, "\\$&").toUpperCase();
}

// --- run_sql guard ---
const SELECT_START = /^[(\s]*(?:select|with)\b/i;
// select * from final table (insert ...) is a write
const WRITES = /\b(?:insert\s+into|delete\s+from|merge\s+into|update\s+\S+\s+set|(?:final|new|old)\s+table\s*\()/i;
// qsys2.qcmdexc is also a scalar function, so a select can run CL
const WRITE_FN = /\b(qcmdexc|http[a-z_]*|ifs_[a-z_]*)\s*\(/i;
const RUNAWAY = /\bsyspartitionindex(?:stat|es)\b/i;
const EDGE = "[^A-Z0-9#$@_]";
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function assertSelectOnly(statement: string, blockedTables: string[] = []): string {
  const sql = statement.trim().replace(/;\s*$/, "");
  if (!sql) throw new Error("empty sql statement");
  // ponytail: comments are refused, not stripped, and literals are not parsed. A quote aware stripper is the upgrade.
  if (/--|\/\*/.test(sql)) throw new Error("remove the comments (-- and /* */), run_sql refuses a statement carrying any");
  if (sql.includes(";")) throw new Error(`run_sql takes one statement, remove the ";"`);
  if (!SELECT_START.test(sql)) throw new Error(`run_sql only runs select, "${sql.replace(/^[(\s]+/, "").split(/[\s(]+/)[0].toLowerCase()}" is not one`);
  if (WRITES.test(sql)) throw new Error("refusing a write inside a select");
  const fn = WRITE_FN.exec(sql);
  if (fn) throw new Error(`refusing to call ${fn[1].toLowerCase()}() from run_sql`);
  const slow = RUNAWAY.exec(sql);
  if (slow) throw new Error(`refusing ${slow[0].toLowerCase()}: it can run for minutes and nothing stops it once it starts. Use qsys.qadbkfld for the key fields of a file, and systools.related_objects for the logical files over one`);
  const upper = sql.toUpperCase();
  const hit = blockedTables.find((t) => new RegExp(`(^|${EDGE})${escapeRegex(t.toUpperCase())}($|${EDGE})`).test(upper));
  if (hit) throw new Error(`${hit.toUpperCase()} is blocked by IBMI_BLOCKED_TABLES`);
  return sql;
}

export function withTimeLimit<T>(work: Promise<T>, ms: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error(message)); }, ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

// --- fndstrpdm listing ---
// Read structurally, never by the English headings, which are translated on another box. srcseq is
// packed(6,2) and prints without its point, so 400 is line 4.00.
// ponytail: a record wider than the print area folds and the tail is dropped, not rejoined.
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
    // a heading, so the block is changing. Forgetting the member here is what stops hits from a
    // member outside `known` being reported under the last one that was in it.
    if (fresh) { member = ""; named = false; fresh = false; }
    if (named) continue; // only the first known name in a block is the member, not a later Type
    const value = raw.split(":")[1]?.trim().split(/\s+/)[0]?.toUpperCase();
    if (value && known.has(value)) { member = value; named = true; }
  }
  return out;
}

// --- local files ---
// UTF-8 (no BOM) with CRLF. The backup refreshes on each read and edits never touch it, so it
// stays a restore point.
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
// ponytail: a cut cell loses its tail, json: true is the escape hatch
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
  // reduce, not Math.max(...spread), which overflows on a big maxRows
  const width = columns.map((_, i) => [...head, ...body].reduce((w, r) => Math.max(w, r[i].length), 0));
  const line = (vals: string[]) => vals.map((v, i) => (num[i] ? v.padStart(width[i]) : v.padEnd(width[i]))).join("  ").trimEnd();
  return [...head.map(line), width.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

export function sqlJson(columns: SqlColumn[], rows: Record<string, unknown>[]): string {
  return `{"columns":${JSON.stringify(columns)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
}
