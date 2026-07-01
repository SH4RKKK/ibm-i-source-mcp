import { test } from "node:test";
import assert from "node:assert/strict";
import { extFor, textContains } from "./util.js";
import { loadProfile } from "./config.js";
import { buildCompileCommand, parseEvfevent } from "./compile.js";

test("extFor maps known types and falls back to .txt", () => {
  assert.equal(extFor("SQLRPGLE"), ".sqlrpgle");
  assert.equal(extFor("clle"), ".clle");
  assert.equal(extFor("weird"), ".txt");
});

test("textContains honours case sensitivity", () => {
  assert.equal(textContains("Onderhoud Afdelingsgegevens", "afdeling"), true); // case-insensitive default
  assert.equal(textContains("Onderhoud Afdelingsgegevens", "afdeling", true), false); // case-sensitive
  assert.equal(textContains("AFDSCHERM", "afd"), true);
});

test("loadProfile reads env and applies defaults", () => {
  const p = loadProfile({ IBMI_HOST: "h", IBMI_USER: "u", IBMI_PASSWORD: "pw" } as any);
  assert.equal(p.password, "pw");
  assert.equal(p.mapepirePort, 8076);
  assert.equal(p.naming, "system");
  assert.equal(p.allowSelfCert, true);
  assert.equal(p.sourceFileCcsid, 37);
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

test("parseEvfevent pulls msgId/severity/text from ERROR records, skips others", () => {
  // NOTE: verify this column layout against a real EVFEVENT (plan step 9) and adjust if needed.
  const lines = [
    "FILEID 0 001 000000 ...",
    "ERROR 0 1 5 5 8 5 12 RNF7030 30 42 The name or indicator TOTAL is not defined.",
    "PROCESSOR 999 1",
  ];
  const errs = parseEvfevent(lines);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].msgId, "RNF7030");
  assert.equal(errs[0].severity, 30);
  assert.match(errs[0].text, /TOTAL is not defined/);
});
