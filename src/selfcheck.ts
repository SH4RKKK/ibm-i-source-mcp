import { test } from "node:test";
import assert from "node:assert/strict";
import { extFor, textContains } from "./util.js";
import { loadProfile } from "./config.js";
import { MapepireBackend } from "./mapepire.js";
import { ToolReporter } from "./report.js";
import { assertCompileCommandAllowed, buildCompileCommand, buildLibraryListCommands, parseEvfevent } from "./compile.js";

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
  // The ERROR record is the real layout from a crtdspf failure. The FILEID line
  // (which the parser skips) has its paths anonymized.
  const lines = [
    "FILEID     0 001 000000 021 MYLIB/QDDSSRC(MYDSPF) 20260101120000 0",
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

test("buildLibraryListCommands builds the right CL per action", () => {
  assert.deepEqual(buildLibraryListCommands("add", { library: "MYLIB" }), ["addlible lib(MYLIB) position(*last)"]);
  assert.deepEqual(buildLibraryListCommands("add", { library: "MYLIB", position: "first" }), ["addlible lib(MYLIB) position(*first)"]);
  assert.deepEqual(buildLibraryListCommands("remove", { library: "MYLIB" }), ["rmvlible lib(MYLIB)"]);
  assert.deepEqual(buildLibraryListCommands("set_current", { library: "MYLIB" }), ["chgcurlib curlib(MYLIB)"]);
  // replace drops QTEMP (implicit) and can set the current library
  assert.deepEqual(buildLibraryListCommands("replace", { libraries: ["A", "QTEMP", "B"], currentLibrary: "C" }), ["chglibl libl(A B) curlib(C)"]);
  assert.deepEqual(buildLibraryListCommands("replace", { libraries: [] }), ["chglibl libl(*none)"]);
});

test("changeLibraryList is refused in read-only mode (before any connect)", async () => {
  const be = new MapepireBackend(loadProfile({ IBMI_HOST: "h", IBMI_USER: "u", IBMI_PASSWORD: "pw", IBMI_READ_ONLY: "true" } as any));
  await assert.rejects(() => be.changeLibraryList("add", { library: "MYLIB" }), /read-only/);
});

test("loadProfile parses the connect timeout, with a 20s default", () => {
  const base = { IBMI_HOST: "h", IBMI_USER: "u", IBMI_PASSWORD: "pw" };
  assert.equal(loadProfile(base as any).connectTimeoutMs, 20000);
  assert.equal(loadProfile({ ...base, IBMI_CONNECT_TIMEOUT_MS: "5000" } as any).connectTimeoutMs, 5000);
});

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

test("ToolReporter: the footer reports stats and replays the trail (last bar state per phase)", () => {
  const r = new ToolReporter("t", { sendProgress: () => {}, sendLog: () => {} });
  r.step("connecting");
  r.bar("scanning A", 1, 3);
  r.bar("scanning B", 3, 3);
  r.step("done scanning");
  r.log("warning", "w");
  const lines = r.footer().split("\n");
  assert.match(lines[0], /^\[t: \d+\.\d+s, \d+ live progress update\(s\) streamed\]$/);
  assert.match(lines[1], /^ +\d+\.\d+s  connecting$/);
  assert.match(lines[2], /scanning B \(3\/3\)$/); // only the final bar state, not every tick
  assert.match(lines[3], /done scanning$/);
  assert.match(lines[4], /warning: w$/);
  assert.equal(lines.length, 5);
  const noToken = new ToolReporter("t", { sendLog: () => {} });
  noToken.step("a");
  assert.match(noToken.footer(), /no progressToken, 1 step\(s\) went to the MCP log/);
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
