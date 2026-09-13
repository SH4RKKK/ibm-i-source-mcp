import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemberRef } from "./types.js";

// --- source types ---
// the source type lowercased, like Code for IBM i, so editors pick the right handler
export function extFor(type: string): string {
  const t = type?.toLowerCase().trim();
  return t ? `.${t}` : ".txt";
}

// inverse of extFor. ".txt" is what extFor emits for a member with no type, so it is not a
// real source type and must never reach addpfm.
export function typeFromPath(path: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toUpperCase();
  return !ext || ext === "TXT" ? undefined : ext;
}

// --- sql escaping ---
// for a `like '%...%' escape '\'` we build. Upper cased because the column is compared upper
// cased, and % and _ are escaped so a filter is a substring rather than a pattern.
export function likeLiteral(term: string): string {
  return term.replace(/'/g, "''").replace(/[\\%_]/g, "\\$&").toUpperCase();
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
