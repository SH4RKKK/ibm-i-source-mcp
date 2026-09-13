import { test } from "node:test";
import assert from "node:assert/strict";
import { extFor, parseFndstrpdm, typeFromPath } from "./util.js";
import { loadProfile } from "./config.js";
import { MapepireBackend, aliasStmt, memberMetaStmt, qcmdexc } from "./mapepire.js";
import { ToolReporter } from "./report.js";
import { assertCompileCommandAllowed, buildCompileCommand, buildLibraryListCommands, parseEvfevent } from "./compile.js";

// the three variables a profile cannot do without, spread where a test adds more
const baseEnv: NodeJS.ProcessEnv = { IBMI_HOST: "h", IBMI_USER: "u", IBMI_PASSWORD: "pw" };

// --- util ---
test("typeFromPath recovers the source type a new member needs", () => {
  // read_source_member saves <member>.<type>, so an upload that has to addpfm can take srctype from the file it is about to send.
  assert.equal(typeFromPath("ibmi-src/MYLIB/QDDSSRC/MYSCREEN.dspf"), "DSPF");
  assert.equal(typeFromPath("C:\work\MYPGM.sqlrpgle"), "SQLRPGLE");
  assert.equal(typeFromPath("MYPGM_reviewed.rpgle"), "RPGLE");
  // .txt is what extFor emits when a member has no type: not a real srctype, so it must come back undefined and force the caller to pass one.
  assert.equal(typeFromPath("notes.txt"), undefined);
  assert.equal(typeFromPath("README"), undefined);
  assert.equal(typeFromPath("X" + extFor("CLLE")), "CLLE"); // round trip with its inverse
});

test("extFor uses the member type as the extension", () => {
  assert.equal(extFor("SQLRPGLE"), ".sqlrpgle");
  assert.equal(extFor("DSPF"), ".dspf"); // display file, not .dds
  assert.equal(extFor("clle"), ".clle");
  assert.equal(extFor(""), ".txt");
});

test("parseFndstrpdm reads the listing structurally, not by its English headings", () => {
  const ruler = "    SEQNBR  " + "*...+....1....+....2....+....3....+....4....+....5....+....6....+....7....+....8....+....9....+....100" + " Last Changed Date";
  const hit = (seq: string, src: string) => seq.padStart(10) + "  " + src.padEnd(108) + "02-06-26";
  const listing = [
    "5770WDS V7R6M0  250418 MYSYS           Programming Development Manager      12-09-26  18:00:04     Page     1",
    "File  . . . . . . . . :   QRPGLESRC",
    "Member  . . . . . . . :   MYPGM                          Creation date . . . . . . :   06-02-26",
    "Type  . . . . . . . . :   RPGLE                          Last changed date . . . . :   06-02-26",
    "Record length . . . . :   112                            Number of records . . . . :   29",
    ruler,
    "            DCL",
    hit("400", "dcl-f myscreen workstn;"),
    hit("1100", "dcl-PI main;"),
    "_ _ _ _ _   E N D   O F   M E M B E R   _ _ _ _ _",
    "Member  . . . . . . . :   MYOTHER                        Creation date . . . . . . :   06-02-26",
    ruler,
    hit("250", "dcl-s x char(10);"),
  ];
  const known = new Set(["MYPGM", "MYOTHER"]);
  assert.deepEqual(parseFndstrpdm(listing, known, "DCL"), [
    { member: "MYPGM", seqNbr: 4, line: "dcl-f myscreen workstn;" },
    { member: "MYPGM", seqNbr: 11, line: "dcl-PI main;" },
    { member: "MYOTHER", seqNbr: 2.5, line: "dcl-s x char(10);" },
  ]);
  // the change date sits past the ruler window, so it never lands in the source line
  assert.ok(!parseFndstrpdm(listing, known, "DCL").some((m) => m.line.includes("02-06-26")));
});

test("parseFndstrpdm does not let a mark line rename the member it is marking", () => {
  const ruler = "    SEQNBR  " + "*...+....1....+....2" + " Last Changed Date";
  const listing = [
    "Member  . . . . . . . :   MYCALLER",
    ruler,
    "            MYCALLED",
    "       300  " + "callp mycalled();".padEnd(20),
  ];
  assert.deepEqual(parseFndstrpdm(listing, new Set(["MYCALLER", "MYCALLED"]), "MYCALLED"),
    [{ member: "MYCALLER", seqNbr: 3, line: "callp mycalled();" }]);
});

test("parseFndstrpdm keeps hits out when the member is not in the catalog list", () => {
  const ruler = "    SEQNBR  " + "*...+....1....+....2" + " Last Changed Date";
  const listing = ["Member  . . . . . . . :   NOTMINE", ruler, "       100  " + "dcl-s a;".padEnd(20)];
  assert.deepEqual(parseFndstrpdm(listing, new Set(["OTHER"]), "dcl"), []);
  assert.deepEqual(parseFndstrpdm([], new Set(["OTHER"]), "dcl"), []);
});

// --- sql templates ---
test("qcmdexc wraps a CL command as one SQL statement, doubling quotes for the literal", () => {
  assert.equal(qcmdexc("clrpfm file(L/F) mbr(M)"), "call qsys2.qcmdexc('clrpfm file(L/F) mbr(M)')");
  // A CL literal already doubles its own quotes, and this level doubles them again, so a description reaches QCMDEXC with the pair it started with.
  assert.equal(qcmdexc("addpfm file(L/F) mbr(M) srctype(RPGLE) text('it''s here')"), "call qsys2.qcmdexc('addpfm file(L/F) mbr(M) srctype(RPGLE) text(''it''''s here'')')");
});

test("aliasStmt guards only the drop, so a missing alias is fine but a bad create still raises", () => {
  const s = aliasStmt("MCPREAD", "MYLIB", "QRPGLESRC", "MYPGM");
  // the handler sits in its own block around the drop, not around the create
  assert.match(s, /begin\s+declare continue handler for sqlexception begin end;\s+execute immediate 'drop alias qtemp\.MCPREAD';\s+end;/);
  assert.match(s, /execute immediate 'create alias qtemp\.MCPREAD for MYLIB\.QRPGLESRC\(MYPGM\)'/);
  assert.ok(!s.includes("ovrdbf") && !s.includes("dltovr"), "no CL left in the read path");
  assert.ok(!s.includes("qcmdexc"), "nothing rides along when nothing was asked for");
  // an extra statement rides along on the same round trip
  assert.ok(aliasStmt("MCPWRITE", "MYLIB", "QRPGLESRC", "MYPGM", qcmdexc("clrpfm file(MYLIB/QRPGLESRC) mbr(MYPGM)")).includes("call qsys2.qcmdexc('clrpfm file(MYLIB/QRPGLESRC) mbr(MYPGM)');"));
});

test("memberMetaStmt answers ccsid, length, type, change date and existence in one query", () => {
  const s = memberMetaStmt("MYLIB", "QRPGLESRC", "MYPGM");
  assert.ok(s.includes("qsys2.syscolumns"), "ccsid and length");
  assert.ok(s.includes("qsys2.syspartitionstat"), "type and last change");
  assert.ok(s.includes("left join"), "a missing member must still return the file's row");
  assert.ok(s.includes("as found"), "the existence flag the upload path checks");
  assert.ok(s.includes("'MYPGM'") && s.includes("'MYLIB'") && s.includes("'QRPGLESRC'"));
  assert.equal((s.match(/select/gi) || []).length, 1, "one statement, not two selects stitched together");
});


// --- config ---
test("loadProfile reads env and applies defaults", () => {
  const p = loadProfile(baseEnv);
  assert.equal(p.password, "pw");
  assert.equal(p.sshPort, 22);
  assert.equal(p.sourceFileCcsid, 37);
  assert.equal(p.readOnly, false);
  assert.deepEqual(p.blockedCl, []);
});

test("loadProfile parses safety options", () => {
  const p = loadProfile({ ...baseEnv, IBMI_READ_ONLY: "true", IBMI_BLOCKED_CL: "crtpf, dltf" });
  assert.equal(p.readOnly, true);
  assert.deepEqual(p.blockedCl, ["crtpf", "dltf"]);
});

test("loadProfile fails loudly when host/user/password missing", () => {
  assert.throws(() => loadProfile({ IBMI_HOST: "h" }), /IBMI_HOST, IBMI_USER and\/or IBMI_PASSWORD/);
});

// --- compile ---
test("assertCompileCommandAllowed permits crt*/runsqlstm, blocks destructive and non-create verbs", () => {
  assert.doesNotThrow(() => assertCompileCommandAllowed("crtdspf file(L/N) srcfile(L/F) srcmbr(M)"));
  assert.doesNotThrow(() => assertCompileCommandAllowed("crtbndrpg pgm(MYLIB/MYPGM)"));
  assert.doesNotThrow(() => assertCompileCommandAllowed("runsqlstm srcfile(L/F) srcmbr(M)"));
  // dlt* / clr* / rmv* families, matched by prefix
  assert.throws(() => assertCompileCommandAllowed("dltlib mylib"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("clrlib mylib"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("rmvm file(l/f) mbr(m)"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("qsys/dltf file(l/f)"), /destructive/); // lib-qualified
  // these come off the explicit verb list, not a prefix
  assert.throws(() => assertCompileCommandAllowed("strsql"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("runqry qryfile(l/f)"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("call pgm(l/p)"), /destructive/);
  assert.throws(() => assertCompileCommandAllowed("dsplib mylib"), /not a create/); // not crt*, not destructive
  assert.throws(() => assertCompileCommandAllowed("crtpf file(l/f)", ["crtpf"]), /destructive/); // admin extra
});

test("buildCompileCommand substitutes tokens; override wins; unknown type throws", () => {
  const cmd = buildCompileCommand("rpgle", { tgtlib: "*CURLIB", name: "MYPGM", srclib: "MYLIB", srcfile: "QRPGLESRC", mbr: "MYPGM" });
  assert.match(cmd, /^crtbndrpg pgm\(\*CURLIB\/MYPGM\) srcfile\(MYLIB\/QRPGLESRC\) srcmbr\(MYPGM\) option\(\*eventf\)/);
  assert.ok(!cmd.includes("&"), "all tokens replaced");
  assert.equal(buildCompileCommand("rpgle", { tgtlib: "L", name: "N", srclib: "SL", srcfile: "SF", mbr: "M" }, "crtbndrpg pgm(L2/&name)"), "crtbndrpg pgm(L2/N)"); // override still gets token substitution
  assert.throws(() => buildCompileCommand("weird", { tgtlib: "L", name: "N", srclib: "SL", srcfile: "SF", mbr: "M" }), /no compile template/);
});

test("parseEvfevent parses a real DDS ERROR record (severity, line, clean text), skips others", () => {
  // The ERROR record is the real layout from a crtdspf failure. The FILEID line (which the parser skips) has its paths anonymized.
  const errs = parseEvfevent([
    "FILEID     0 001 000000 021 MYLIB/QDDSSRC(MYDSPF) 20260101120000 0",
    "ERROR      0 001 1 001700 000017 045 000017 045 CPD7484 E 20 200 Keyword not valid for this file type.",
    "PROCESSOR  0 000 1",
  ]);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].msgId, "CPD7484");
  assert.equal(errs[0].severity, 20); // the number, not the "E" class letter
  assert.equal(errs[0].line, 17);
  assert.equal(errs[0].toLine, 17);
  assert.equal(errs[0].text, "Keyword not valid for this file type."); // no stray length token
});

test("parseEvfevent also handles an ERROR record with no severity-class letter", () => {
  const errs = parseEvfevent(["ERROR 0 001 1 001700 000017 045 000017 045 CPD7484 20 200 Keyword not valid for this file type."]);
  assert.equal(errs[0].severity, 20);
  assert.equal(errs[0].line, 17);
  assert.equal(errs[0].text, "Keyword not valid for this file type.");
});

test("buildLibraryListCommands builds the right CL per action", () => {
  assert.deepEqual(buildLibraryListCommands("add", { library: "MYLIB" }), ["addlible lib(MYLIB) position(*last)"]);
  assert.deepEqual(buildLibraryListCommands("add", { library: "MYLIB", position: "first" }), ["addlible lib(MYLIB) position(*first)"]);
  assert.deepEqual(buildLibraryListCommands("remove", { library: "MYLIB" }), ["rmvlible lib(MYLIB)"]);
  assert.deepEqual(buildLibraryListCommands("set_current", { library: "MYLIB" }), ["chgcurlib curlib(MYLIB)"]);
  // replace drops QTEMP (implicit) and can set the current library
  assert.deepEqual(buildLibraryListCommands("replace", { libraries: ["A", "QTEMP", "B"], currentLibrary: "C" }), ["chglibl libl(A B) curlib(C)"]);
  assert.deepEqual(buildLibraryListCommands("replace", { libraries: [] }), ["chglibl libl(*none)"]);
});

// --- backend guards ---
test("changeLibraryList is refused in read-only mode (before any connect)", async () => {
  const be = new MapepireBackend(loadProfile({ ...baseEnv, IBMI_READ_ONLY: "true" }));
  await assert.rejects(() => be.changeLibraryList("add", { library: "MYLIB" }), /read-only/);
});

// --- reporter ---
test("ToolReporter: progress values only ever increase, and bar phases stay aligned after steps", () => {
  const sent: { p: number; t?: number; m: string }[] = [];
  const r = new ToolReporter("t", { sendProgress: (p, t, m) => sent.push({ p, t, m }), sendLog: () => {} });
  r.step("connect");        // 1, always sent
  r.bar("scan a", 1, 3);    // throttled away (right after the step, not final)
  r.bar("scan b", 3, 3);    // final bar of the phase, always sent: base 1 -> 4/4
  r.step("done");           // 5
  assert.equal(sent.length, 3);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].p > sent[i - 1].p, `progress must increase (${sent[i - 1].p} -> ${sent[i].p})`);
  assert.deepEqual(sent[1], { p: 4, t: 4, m: "scan b" });
});

test("ToolReporter: without a progress token, steps fall back to info log notifications", () => {
  const logs: string[] = [];
  const r = new ToolReporter("t", { sendLog: (lvl, m) => logs.push(`${lvl}:${m}`) });
  r.step("connecting");
  r.log("warning", "w");
  assert.deepEqual(logs, ["info:connecting", "warning:w"]);
});

test("ToolReporter: failResult names the tool and carries the message, with no footer", () => {
  const logs: string[] = [];
  const r = new ToolReporter("read_source_member", { sendLog: (lvl, m) => logs.push(`${lvl}:${m}`) });
  const out = r.failResult(new Error("member not found"));
  assert.equal(out.isError, true);
  assert.equal(out.content[0].text, "read_source_member failed: member not found");
  assert.deepEqual(logs, ["error:read_source_member failed: member not found"]);
});

test("ToolReporter: the stall watchdog repeats the last message during silence and stops on dispose", async () => {
  const sent: string[] = [];
  const r = new ToolReporter("t", { sendProgress: (_p, _t, m) => sent.push(m), sendLog: () => {} }, 80).start();
  r.step("connecting to box");
  await new Promise((res) => setTimeout(res, 300));
  r.dispose();
  const nudges = sent.filter((m) => m.includes("still working"));
  assert.ok(nudges.length >= 1, `expected at least one nudge, got: ${sent.join(" | ")}`);
  assert.match(nudges[0], /still working: connecting to box \(\d+s elapsed\)/);
  const count = sent.length;
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(sent.length, count, "nothing may be sent after dispose");
});
