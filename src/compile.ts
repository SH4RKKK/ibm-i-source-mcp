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
  if (!template) throw new Error(`no compile template for type "${type}" — pass an explicit \`command\``);
  return substitute(template, v);
}

const MSGID = /^[A-Z]{2,4}\d{3,4}$/; // RNF7030, CPD0043, SQL0312, MSG...

// Parse EVFEVENT ERROR records into structured errors. msgId/severity/text are
// anchored on the msgId token (reliable). Line columns follow the documented
// ERROR layout (fileId annotClass stmtLine startLine startCol endLine endCol …)
// but are best-effort — verify against a real compile (plan step 9) and adjust
// the indices if a box's layout differs. The full listing carries the errors
// regardless, so a wrong line number degrades gracefully.
export function parseEvfevent(lines: string[]): CompileError[] {
  const out: CompileError[] = [];
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/);
    if (t[0] !== "ERROR") continue;
    const i = t.findIndex((tok) => MSGID.test(tok));
    if (i < 0) continue;
    const severity = Number(t[i + 1]);
    // t[i+2] is the text length; the message follows it.
    const text = t.slice(i + 3).join(" ").trim();
    const startLine = Number(t[4]);
    const endLine = Number(t[6]);
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
