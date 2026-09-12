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
// for a `like '%...%'` we build. Upper cased because the column is compared upper cased.
export function likeLiteral(term: string): string {
  return term.replace(/'/g, "''").toUpperCase();
}

// For a `like '%...%' escape '\'` inside a dynamic statement that is itself a literal inside a
// compound statement (see searchSource). Both backslashes below are load bearing: drop one and
// `_` silently becomes a wildcard again. An apostrophe becomes four, one pair per parse level.
export function nestedLikeNeedle(term: string, caseSensitive = false): string {
  return (caseSensitive ? term : term.toUpperCase())
    .replace(/[\\%_]/g, "\\$&")
    .replace(/'/g, "''''");
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
