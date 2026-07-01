import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemberRef } from "./types.js";

// Local file extension = the member's source type, lowercased (rpgle -> .rpgle,
// dspf -> .dspf, prtf -> .prtf, pf/lf -> .pf/.lf, ...). This is what Code for
// IBM i does and it lets editors and language tooling pick the right handler.
// A member with no type falls back to .txt.
export function extFor(type: string): string {
  const t = type?.toLowerCase().trim();
  return t ? `.${t}` : ".txt";
}

export function textContains(haystack: string, needle: string, caseSensitive = false): boolean {
  return caseSensitive ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase());
}

// Write UTF-8 (no BOM) + CRLF. Also drops a pristine copy of exactly what was
// fetched under a single .backup/ root that mirrors the lib/file/member tree
// (baseDir/.backup/<lib>/<file>/<member>.<ext>), so the original is recoverable
// if an edit goes wrong. The backup is refreshed on every read and never
// touched by edits. Returns both paths.
export function writeLocalCopy(baseDir: string, ref: MemberRef, type: string, content: string): { path: string; backup: string } {
  const name = ref.member + extFor(type);
  const crlf = content.replace(/\r?\n/g, "\r\n");

  const path = join(baseDir, ref.library, ref.sourceFile, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, crlf, "utf8");

  const backup = join(baseDir, ".backup", ref.library, ref.sourceFile, name);
  mkdirSync(dirname(backup), { recursive: true });
  writeFileSync(backup, crlf, "utf8");

  return { path, backup };
}

// Find the copy read_source_member wrote (any extension), for upload round-trips.
export function findLocalCopy(baseDir: string, ref: MemberRef): string {
  const dir = join(baseDir, ref.library, ref.sourceFile);
  const hit = readdirSync(dir).find((f) => f.replace(/\.[^.]*$/, "") === ref.member);
  if (!hit) throw new Error(`no local copy in ${dir} for ${ref.member} — read it first, or pass localPath/content`);
  return join(dir, hit);
}
