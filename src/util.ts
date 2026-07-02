import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemberRef } from "./types.js";

// Extension = the member's source type, lowercased (dspf, rpgle, pf, lf, ...),
// like Code for IBM i, so editors pick the right handler. No type gives .txt.
export function extFor(type: string): string {
  const t = type?.toLowerCase().trim();
  return t ? `.${t}` : ".txt";
}

export function textContains(haystack: string, needle: string, caseSensitive = false): boolean {
  return caseSensitive ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase());
}

// Write UTF-8 (no BOM) with CRLF, plus a pristine backup under a single .backup/
// root mirroring the tree (baseDir/.backup/<lib>/<file>/<member>.<ext>). The
// backup refreshes on each read and edits never touch it, so it is a restore point.
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

// Find the copy read_source_member wrote (any extension), for upload round trips.
export function findLocalCopy(baseDir: string, ref: MemberRef): string {
  const dir = join(baseDir, ref.library, ref.sourceFile);
  const hit = readdirSync(dir).find((f) => f.replace(/\.[^.]*$/, "") === ref.member);
  if (!hit) throw new Error(`no local copy in ${dir} for ${ref.member}, read it first or pass localPath/content`);
  return join(dir, hit);
}
