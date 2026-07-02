import type { CompileError } from "./types.js";

// Member-compile CL per source type (lowercased, house style). All ILE types
// carry option(*eventf) so the compiler writes an EVFEVENT error file.
// Tokens: &tgtlib &name &srclib &srcfile &mbr
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

export interface CompileVars {
  tgtlib: string;
  name: string;
  srclib: string;
  srcfile: string;
  mbr: string;
}

function substitute(template: string, v: CompileVars): string {
  return template.replace(/&(tgtlib|name|srclib|srcfile|mbr)/g, (_, k: keyof CompileVars) => v[k]);
}

// override wins; otherwise the template for the type. Tokens are substituted in
// both so an override can use &name etc. Unknown type + no override -> throw.
export function buildCompileCommand(type: string | undefined, v: CompileVars, override?: string): string {
  if (override) return substitute(override, v);
  const template = COMMAND_TEMPLATES[(type || "").toLowerCase()];
  if (!template) throw new Error(`no compile template for type "${type}", pass an explicit \`command\``);
  return substitute(template, v);
}

// The `command` override runs as CL as the connected profile, so we guard it:
// allow only crt* (and runsqlstm) and refuse destructive verbs. Whole families
// go by prefix (any dlt*, clr*, rmv*), plus the explicit set below and anything
// in IBMI_BLOCKED_CL. A safety net, not the primary control: the profile's
// authority is. One QCMDEXC command cannot chain another, so the verb is enough.
const DESTRUCTIVE_PREFIXES = ["dlt", "clr", "rmv"];
const DESTRUCTIVE_CL = new Set([
  "rgzpfm", "savlib", "savobj", "rstlib", "rstobj", "crtusrprf", "chgusrprf",
  "grtobjaut", "rvkobjaut", "chgobjown", "pwrdwnsys", "endsbs", "endsys", "endtcp",
  "sbmjob", "call", "qsh", "strqsh", "strsql", "rundsql", "runsql", "runqry",
]);

// The leading verb, unqualified (lib/cmd becomes cmd), lowercased.
function verbOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] || "";
  const bare = first.includes("/") ? first.slice(first.lastIndexOf("/") + 1) : first;
  return bare.toLowerCase();
}

function isDestructive(verb: string, extraBlocked: string[]): boolean {
  return DESTRUCTIVE_PREFIXES.some((p) => verb.startsWith(p)) || DESTRUCTIVE_CL.has(verb) || extraBlocked.includes(verb);
}

export function assertCompileCommandAllowed(command: string, extraBlocked: string[] = []): void {
  const verb = verbOf(command);
  if (!verb) throw new Error("empty compile command");
  if (isDestructive(verb, extraBlocked)) {
    throw new Error(`refusing to run destructive CL command "${verb}" as a compile command`);
  }
  if (!verb.startsWith("crt") && verb !== "runsqlstm") {
    throw new Error(`compile command "${verb}" is not a create (crt*) command, pass a crt* command or use a CL tool if you need something else`);
  }
}

const MSGID = /^[A-Z]{2,4}\d{3,4}$/; // RNF7030, CPD0043, SQL0312, MSG...

// Parse EVFEVENT ERROR records, anchored on the msgId token so we do not depend
// on the leading column widths. Real DDS record:
//   ERROR 0 001 1 <seqnbr> <startLine> <startCol> <endLine> <endCol> <msgId> <sevClass> <sev> <textLen> <text>
// Before msgId: startLine startCol endLine endCol. After: an optional one letter
// severity class (E/W/I/S), the severity, the text length, then the message.
export function parseEvfevent(lines: string[]): CompileError[] {
  const out: CompileError[] = [];
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/);
    if (t[0] !== "ERROR") continue;
    const i = t.findIndex((tok) => MSGID.test(tok));
    if (i < 0) continue;

    // After msgId: optional severity class letter, severity, text length, text.
    let j = i + 1;
    if (/^[A-Za-z]$/.test(t[j] ?? "")) j++; // skip the severity class letter
    const severity = Number(t[j]);
    const text = t.slice(j + 2).join(" ").trim(); // t[j+1] is the text length

    // Before the msgId: startLine startCol endLine endCol.
    const startLine = Number(t[i - 4]);
    const endLine = Number(t[i - 2]);

    out.push({
      severity: Number.isFinite(severity) ? severity : 0,
      msgId: t[i],
      line: Number.isFinite(startLine) ? startLine : undefined,
      toLine: Number.isFinite(endLine) ? endLine : undefined,
      text: text || raw.trim(),
    });
  }
  return out;
}
