import type { CompileError, LibraryListAction, LibraryListChange } from "./types.js";

// --- library list ---
export function buildLibraryListCommands(action: LibraryListAction, a: LibraryListChange): string[] {
  switch (action) {
    case "add": return [`addlible lib(${a.library}) position(*${a.position ?? "last"})`];
    case "remove": return [`rmvlible lib(${a.library})`];
    case "set_current": return [`chgcurlib curlib(${a.library})`];
    case "replace": {
      const libs = (a.libraries ?? []).filter((l) => l !== "QTEMP");
      const cur = a.currentLibrary ? ` curlib(${a.currentLibrary})` : "";
      return [`chglibl libl(${libs.length ? libs.join(" ") : "*none"})${cur}`];
    }
  }
}

// --- compile commands ---
export const COMMAND_TEMPLATES: Record<string, string> = {
  rpgle: "crtbndrpg pgm(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf) dbgview(*source) tgtccsid(*job)",
  sqlrpgle: "crtsqlrpgi obj(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf) dbgview(*source) commit(*none) rpgppopt(*lvl2)",
  clle: "crtbndcl pgm(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf) dbgview(*source)",
  clp: "crtbndcl pgm(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf) dbgview(*source)",
  cbl: "crtbndcbl pgm(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf)",
  cblle: "crtbndcbl pgm(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf)",
  sqlcblle: "crtsqlcbli obj(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf) commit(*none)",
  dspf: "crtdspf file(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf)",
  prtf: "crtprtf file(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf)",
  pf: "crtpf file(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf)",
  lf: "crtlf file(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf)",
  cmd: "crtcmd cmd(&tgtlib/&name) pgm(&tgtlib/&name) srcfile(&srclib/&srcfile) srcmbr(&mbr) option(*eventf)",
  sql: "runsqlstm srcfile(&srclib/&srcfile) srcmbr(&mbr) commit(*none) naming(*sys)",
};

export interface CompileVars { tgtlib: string; name: string; srclib: string; srcfile: string; mbr: string }

export function buildCompileCommand(type: string | undefined, v: CompileVars, override?: string): string {
  const template = override || COMMAND_TEMPLATES[(type || "").toLowerCase()];
  if (!template) throw new Error(`no compile template for type "${type}", pass an explicit \`command\``);
  return template.replace(/&(tgtlib|name|srclib|srcfile|mbr)/g, (_, k: keyof CompileVars) => v[k]);
}

// the command without tgtccsid, when the box rejected a keyword of it (CPD0043)
export function withoutRejectedTgtccsid(command: string, messageIds: (string | null)[]): string | undefined {
  if (!messageIds.includes("CPD0043") || !/\btgtccsid\(/i.test(command)) return undefined;
  return command.replace(/\s+tgtccsid\([^)]*\)/i, "");
}

// --- command guard ---
const DESTRUCTIVE_PREFIXES = ["dlt", "clr", "rmv"];
const DESTRUCTIVE_CL = new Set([
  "rgzpfm", "savlib", "savobj", "rstlib", "rstobj", "crtusrprf", "chgusrprf",
  "grtobjaut", "rvkobjaut", "chgobjown", "pwrdwnsys", "endsbs", "endsys", "endtcp",
  "sbmjob", "call", "qsh", "strqsh", "strsql", "rundsql", "runsql", "runqry",
]);

const verbOf = (command: string): string => (command.trim().split(/\s+/)[0] || "").split("/").pop()!.toLowerCase();

export function assertCompileCommandAllowed(command: string, extraBlocked: string[] = []): void {
  const verb = verbOf(command);
  if (!verb) throw new Error("empty compile command");
  if (DESTRUCTIVE_PREFIXES.some((p) => verb.startsWith(p)) || DESTRUCTIVE_CL.has(verb) || extraBlocked.includes(verb)) {
    throw new Error(`refusing to run destructive CL command "${verb}" as a compile command`);
  }
  if (!verb.startsWith("crt") && verb !== "runsqlstm") {
    throw new Error(`compile command "${verb}" is not a create (crt*) command, pass a crt* command or use a CL tool if you need something else`);
  }
}

// --- evfevent ---
const MSGID = /^[A-Z]{2,4}\d{3,4}$/;

// reads ERROR 0 001 1 <seqnbr> <startLine> <startCol> <endLine> <endCol> <msgId> [<sevClass>] <sev> <textLen> <text>
export function parseEvfevent(lines: string[]): CompileError[] {
  const out: CompileError[] = [];
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/);
    if (t[0] !== "ERROR") continue;
    const i = t.findIndex((tok) => MSGID.test(tok));
    if (i < 0) continue;
    let j = i + 1;
    if (/^[A-Za-z]$/.test(t[j] ?? "")) j++;
    const severity = Number(t[j]);
    const text = t.slice(j + 2).join(" ").trim();
    const startLine = Number(t[i - 4]);
    out.push({
      severity: Number.isFinite(severity) ? severity : 0,
      msgId: t[i],
      line: Number.isFinite(startLine) ? startLine : undefined,
      text: text || raw.trim(),
    });
  }
  return out;
}
