import { test } from "node:test";
import assert from "node:assert/strict";
import { extFor, textContains } from "./util.js";
import { loadProfile } from "./config.js";
import { assertCompileCommandAllowed, buildCompileCommand, parseEvfevent } from "./compile.js";

test("extFor uses the member type as the extension", () => {
  assert.equal(extFor("SQLRPGLE"), ".sqlrpgle");
  assert.equal(extFor("DSPF"), ".dspf"); // display file, not .dds
  assert.equal(extFor("clle"), ".clle");
  assert.equal(extFor(""), ".txt");      // no type -> .txt
});

test("textContains honours case sensitivity", () => {
  assert.equal(textContains("Onderhoud Afdelingsgegevens", "afdeling"), true); // case-insensitive default
  assert.equal(textContains("Onderhoud Afdelingsgegevens", "afdeling", true), false); // case-sensitive
  assert.equal(textContains("AFDSCHERM", "afd"), true);
});

test("loadProfile reads env and applies defaults", () => {
  const p = loadProfile({ IBMI_HOST: "h", IBMI_USER: "u", IBMI_PASSWORD: "pw" } as any);
  assert.equal(p.password, "pw");
  assert.equal(p.sshPort, 22);
  assert.equal(p.naming, "system");
  assert.equal(p.sourceFileCcsid, 37);
  assert.equal(p.readOnly, false);
  assert.deepEqual(p.blockedCl, []);
});

test("loadProfile parses safety options", () => {
  const p = loadProfile({ IBMI_HOST: "h", IBMI_USER: "u", IBMI_PASSWORD: "pw", IBMI_READ_ONLY: "true", IBMI_BLOCKED_CL: "crtpf, dltf" } as any);
  assert.equal(p.readOnly, true);
  assert.deepEqual(p.blockedCl, ["crtpf", "dltf"]);
});

test("assertCompileCommandAllowed permits crt*/runsqlstm, blocks destructive and non-create verbs", () => {
  assert.doesNotThrow(() => assertCompileCommandAllowed("crtdspf file(L/N) srcfile(L/F) srcmbr(M)"));
  assert.doesNotThrow(() => assertCompileCommandAllowed("crtbndrpg pgm(MYLIB/MYPGM)"));
  assert.doesNotThrow(() => assertCompileCommandAllowed("runsqlstm srcfile(L/F) srcmbr(M)"));
  // dlt* / clr* / rmv* families, matched by prefix
  assert.throws(() => assertCompileCommandAllowed("dltlib mylib"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("clrlib mylib"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("rmvm file(l/f) mbr(m)"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("qsys/dltf file(l/f)"), /destructive/); // lib-qualified
  // explicit verbs, including strsql and runqry
  assert.throws(() => assertCompileCommandAllowed("strsql"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("runqry qryfile(l/f)"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("call pgm(l/p)"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("dsplib mylib"), /not a create/); // not crt*, not destructive
  assert.throws(() => assertCompileCommandAllowed("crtpf file(l/f)", ["crtpf"]), /destructive/); // admin extra
});

test("loadProfile fails loudly when host/user/password missing", () => {
  assert.throws(() => loadProfile({ IBMI_HOST: "h" } as any), /IBMI_HOST, IBMI_USER and\/or IBMI_PASSWORD/);
});

test("buildCompileCommand substitutes tokens; override wins; unknown type throws", () => {
  const cmd = buildCompileCommand("rpgle", { tgtlib: "*CURLIB", name: "MYPGM", srclib: "MYLIB", srcfile: "QRPGLESRC", mbr: "MYPGM" });
  assert.match(cmd, /^crtbndrpg pgm\(\*CURLIB\/MYPGM\) srcfile\(MYLIB\/QRPGLESRC\) srcmbr\(MYPGM\) option\(\*eventf\)/);
  assert.ok(!cmd.includes("&"), "all tokens replaced");
  const ov = buildCompileCommand("rpgle", { tgtlib: "L", name: "N", srclib: "SL", srcfile: "SF", mbr: "M" }, "crtbndrpg pgm(L2/&name)");
  assert.equal(ov, "crtbndrpg pgm(L2/N)"); // override still gets token substitution
  assert.throws(() => buildCompileCommand("weird", { tgtlib: "L", name: "N", srclib: "SL", srcfile: "SF", mbr: "M" }), /no compile template/);
});

test("parseEvfevent parses a real DDS ERROR record (severity, line, clean text), skips others", () => {
  // Captured verbatim from a real crtdspf failure on the box.
  const lines = [
    "FILEID     0 001 000000 024 MYLIB/QDDSSRC(MYDSPF) 20260101120000 0",
    "ERROR      0 001 1 001700 000017 045 000017 045 CPD7484 E 20 200 Keyword not valid for this file type.",
    "PROCESSOR  0 000 1",
  ];
  const errs = parseEvfevent(lines);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].msgId, "CPD7484");
  assert.equal(errs[0].severity, 20); // the number, not the "E" class letter
  assert.equal(errs[0].line, 17);
  assert.equal(errs[0].toLine, 17);
  assert.equal(errs[0].text, "Keyword not valid for this file type."); // no stray length token
});

test("parseEvfevent also handles an ERROR record with no severity-class letter", () => {
  const lines = ["ERROR 0 001 1 001700 000017 045 000017 045 CPD7484 20 200 Keyword not valid for this file type."];
  const errs = parseEvfevent(lines);
  assert.equal(errs[0].severity, 20);
  assert.equal(errs[0].line, 17);
  assert.equal(errs[0].text, "Keyword not valid for this file type.");
});
