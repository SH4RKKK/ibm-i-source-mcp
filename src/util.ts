import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemberRef } from "./types.js";

// Member type -> local file extension. Fallback .txt.
const EXT: Record<string, string> = {
  rpgle: ".rpgle",
  sqlrpgle: ".sqlrpgle",
  rpg: ".rpg",
  clle: ".clle",
  clp: ".clp",
  cmd: ".cmd",
  dspf: ".dds",
  prtf: ".dds",
  pf: ".dds",
  lf: ".dds",
  sql: ".sql",
  txt: ".txt",
};

export function extFor(type: string): string {
  return EXT[type?.toLowerCase()] ?? ".txt";
}

export function textContains(haystack: string, needle: string, caseSensitive = false): boolean {
  return caseSensitive ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase());
}

// Write UTF-8 (no BOM) + CRLF, matching the existing *_converted files.
// Returns the path written.
export function writeLocalCopy(baseDir: string, ref: MemberRef, type: string, content: string): string {
  const path = join(baseDir, ref.library, ref.sourceFile, ref.member + extFor(type));
  mkdirSync(dirname(path), { recursive: true });
  const crlf = content.replace(/\r?\n/g, "\r\n");
  writeFileSync(path, crlf, "utf8");
  return path;
}

// Find the copy read_source_member wrote (any extension), for upload round-trips.
export function findLocalCopy(baseDir: string, ref: MemberRef): string {
  const dir = join(baseDir, ref.library, ref.sourceFile);
  const hit = readdirSync(dir).find((f) => f.replace(/\.[^.]*$/, "") === ref.member);
  if (!hit) throw new Error(`no local copy in ${dir} for ${ref.member} — read it first, or pass localPath/content`);
  return join(dir, hit);
}
