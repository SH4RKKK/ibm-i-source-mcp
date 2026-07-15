#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listServers, loadProfileFor } from "./config.js";
import { MapepireBackend } from "./mapepire.js";
import { makeReporter, ToolReporter } from "./report.js";
import { findLocalCopy, writeLocalCopy } from "./util.js";

// Success result with the reporter's stats footer: what ran, for how long, and
// whether progress was streamed. It is the visible trace of a call in clients
// that render no live progress (the VS Code extension today shows only the
// tool name while a call runs). footerFirst puts the footer at the top for
// results whose payload can be huge (compiler listings), since clients
// truncate the tail of big results and would cut a trailing footer.
const done = (r: ToolReporter, text: string, footerFirst = false) => ({
  content: [{ type: "text" as const, text: footerFirst ? `${r.footer()}\n${text}` : `${text.trimEnd()}\n\n${r.footer()}` }],
});

// stdout is the JSON-RPC channel, keep it clean: route console.log (including
// from deps) to stderr, and do not let a stray async error kill the transport.
console.log = (...a: unknown[]) => console.error(...a);
process.on("unhandledRejection", (r) => console.error("[ibm-i-source] unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("[ibm-i-source] uncaughtException:", e));

const LOCAL_DIR = process.env.IBMI_LOCAL_DIR || "ibmi-src";

// One cached backend per server, so switching boxes reuses the open session.
// Config loads lazily, so the server still starts and lists its tools with no
// env file, and a bad config surfaces as a tool error, not a startup crash.
const backends = new Map<string, MapepireBackend>();
async function getBackend(server?: string): Promise<MapepireBackend> {
  const key = server?.toLowerCase() || "default";
  let be = backends.get(key);
  if (!be) {
    be = new MapepireBackend(loadProfileFor(server));
    backends.set(key, be);
  }
  return be;
}

// Reused by every tool: an optional server name selecting a .env.<name> file.
const serverArg = z.string().optional().describe("which IBM i to use, named by a .env.<name> file. Omit for the default .env server (see list_servers)");

// The logging capability lets tools push notifications/message log lines to the
// client; progress notifications ride on the progressToken each request brings.
// Every tool builds a reporter (report.ts) that narrates what is happening.
const mcp = new McpServer({ name: "ibm-i-source", version: "0.5.0" }, { capabilities: { logging: {} } });

mcp.tool(
  "read_source_member",
  "Download an IBM i source member as clean UTF-8 into a local editable copy, plus a pristine backup. Returns the saved paths and metadata, not the source text: read the saved file to see the code.",
  {
    library: z.string().describe("library / schema, e.g. MYLIB"),
    sourceFile: z.string().describe("source physical file, e.g. QRPGLESRC"),
    member: z.string().describe("member name, e.g. MYPGM"),
    server: serverArg,
  },
  async ({ library, sourceFile, member, server }, extra) => {
    const r = makeReporter(mcp, extra, "read_source_member");
    try {
      const be = await getBackend(server);
      const { content, meta } = await be.readMember({ library, sourceFile, member }, r);
      r.step("saving the local copy");
      const { path, backup } = writeLocalCopy(LOCAL_DIR, { library, sourceFile, member }, meta.type, content);
      r.log("info", `read ${library}/${sourceFile}(${member}): ${meta.lineCount} lines saved to ${path}`);
      const text =
        `Saved: ${path}\n` +
        `Backup: ${backup}\n` +
        `Type: ${meta.type}  CCSID: ${meta.ccsid}  Lines: ${meta.lineCount}` +
        (meta.lastChanged ? `  Changed: ${meta.lastChanged}` : "") +
        `  Transport: mapepire\n\n` +
        `The source is in the saved file, read it from there.`;
      return done(r, text);
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "search_source",
  "Discovery search across a library: a member matches if the term is in its NAME, its TEXT description, or its code. Great for finding a member by its purpose (e.g. a Dutch word like 'afdeling'). Scope with sourceFile to keep it fast.",
  {
    library: z.string().describe("library to search"),
    searchTerm: z.string().describe("literal string to find (not a regex), try a purpose word, e.g. afdeling"),
    sourceFile: z.string().optional().describe("limit to one source file, e.g. QDDSSRC"),
    memberType: z.string().optional().describe("limit to a member type, e.g. DSPF, RPGLE"),
    caseSensitive: z.boolean().optional().describe("default false"),
    maxResults: z.number().optional().describe("default 200"),
    server: serverArg,
  },
  async ({ server, ...opts }, extra) => {
    const r = makeReporter(mcp, extra, "search_source");
    try {
      const be = await getBackend(server);
      const { matches, truncated } = await be.searchSource(opts, r);
      const lines = matches.map((m) => {
        const loc = `${m.library}/${m.sourceFile}(${m.member})${m.type ? ` [${m.type}]` : ""}`;
        if (m.matchedOn === "code") return `${loc} code:${m.seqNbr}: ${m.line}`;
        if (m.matchedOn === "text") return `${loc} text: "${m.text}"`;
        if (m.matchedOn === "name") return `${loc} name${m.text ? `: "${m.text}"` : ""}`;
        return `${loc}: ${m.line ?? ""}`;
      });
      const head = `${matches.length} match(es)${truncated ? ` (truncated at maxResults)` : ""}\n\n`;
      return done(r, head + (lines.join("\n") || "(no matches)"));
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "list_libraries",
  "List libraries (schemas) on the IBM i with their text descriptions, so you can discover where source lives before drilling in with list_source_files and list_members. Lists user libraries by default. Pass filter to narrow by a substring of the library name or its description, e.g. a project or application name.",
  {
    filter: z.string().optional().describe("substring to match against the library name or its text, case-insensitive. Omit to list all user libraries."),
    includeSystem: z.boolean().optional().describe("also include the IBM Q* system libraries (default false, user libraries only)"),
    server: serverArg,
  },
  async ({ filter, includeSystem, server }, extra) => {
    const r = makeReporter(mcp, extra, "list_libraries");
    try {
      const be = await getBackend(server);
      const libs = await be.listLibraries(filter, includeSystem, r);
      const lines = libs.map((l) => `${l.name}${l.text ? `: ${l.text}` : ""}`);
      const head = `${libs.length} librar${libs.length === 1 ? "y" : "ies"}${filter ? ` matching "${filter}"` : ""}:\n\n`;
      return done(r, head + (lines.join("\n") || "(none)"));
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "manage_library_list",
  "View or change the connection's library list. `show` returns the current list (SYSTEM/PRODUCT/CURRENT/USER portions). `add` and `remove` add or drop one library (ADDLIBLE/RMVLIBLE), `set_current` sets the current library (CHGCURLIB), and `replace` sets the whole user portion (CHGLIBL). Changes last for the session and are used by later compiles, like adding a library on the green screen. It only changes the job's library list, never objects or data. Use this when a compile needs a library that is not on the sign-on list. The change actions are disabled when IBMI_READ_ONLY is set; `show` always works.",
  {
    action: z.enum(["show", "add", "remove", "set_current", "replace"]).describe("show the list, add/remove one library, set the current library, or replace the whole user portion"),
    library: z.string().optional().describe("the library for add, remove, or set_current"),
    libraries: z.array(z.string()).optional().describe("the full user library list for replace, in search order (first = highest priority)"),
    position: z.enum(["first", "last"]).optional().describe("for add: put it first (searched first) or last (default)"),
    currentLibrary: z.string().optional().describe("for replace: also set the current library"),
    server: serverArg,
  },
  async ({ action, library, libraries, position, currentLibrary, server }, extra) => {
    const r = makeReporter(mcp, extra, "manage_library_list");
    try {
      const be = await getBackend(server);
      const entries = action === "show"
        ? await be.readLibraryList(r)
        : await be.changeLibraryList(action, { library, libraries, position, currentLibrary }, r);
      const body = entries.map((e) => `  ${e.portion.padEnd(8)} ${e.library}`).join("\n");
      const head = action === "show" ? "Library list:" : `Done (${action}). Library list now:`;
      return done(r, `${head}\n\n${body || "(empty)"}`);
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "list_source_files",
  "List the source physical files in a library (e.g. QRPGLESRC, QDDSSRC) with their text descriptions. Use to explore where source lives before listing members.",
  { library: z.string(), server: serverArg },
  async ({ library, server }, extra) => {
    const r = makeReporter(mcp, extra, "list_source_files");
    try {
      const be = await getBackend(server);
      const files = await be.listSourceFiles(library, r);
      const lines = files.map((f) => `${f.name}${f.text ? `: ${f.text}` : ""}`);
      return done(r, `${files.length} source file(s) in ${library}:\n\n` + (lines.join("\n") || "(none)"));
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "list_members",
  "Browse members in a library (like PDM/RDi): each member with its name, type, and TEXT description. Omit sourceFile to list across all source files. Use to find a member by its described purpose, then read_source_member to download it.",
  {
    library: z.string(),
    sourceFile: z.string().optional().describe("limit to one source file, e.g. QDDSSRC"),
    memberType: z.string().optional().describe("limit to a type, e.g. DSPF"),
    server: serverArg,
  },
  async ({ library, sourceFile, memberType, server }, extra) => {
    const r = makeReporter(mcp, extra, "list_members");
    try {
      const be = await getBackend(server);
      const members = await be.listMembers(library, sourceFile, memberType, r);
      const lines = members.map((m) => `${m.sourceFile}(${m.name}) [${m.type || "?"}]${m.text ? `: ${m.text}` : ""}`);
      return done(r, `${members.length} member(s) in ${library}${sourceFile ? `/${sourceFile}` : ""}:\n\n` + (lines.join("\n") || "(none)"));
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "upload_source_member",
  "Upload an edited local copy back into a source member on the IBM i (read-modify-write). Defaults to the copy read_source_member wrote.",
  {
    library: z.string(),
    sourceFile: z.string(),
    member: z.string(),
    localPath: z.string().optional().describe("path to the edited file; defaults to the local copy from read_source_member"),
    content: z.string().optional().describe("upload this text directly instead of reading a file"),
    server: serverArg,
  },
  async ({ library, sourceFile, member, localPath, content, server }, extra) => {
    const r = makeReporter(mcp, extra, "upload_source_member");
    try {
      const be = await getBackend(server);
      const ref = { library, sourceFile, member };
      let text = content;
      if (text === undefined) {
        const path = localPath ?? findLocalCopy(LOCAL_DIR, ref);
        r.step(`reading the local file ${path}`);
        text = readFileSync(path, "utf8");
      }
      const { warnings } = await be.writeMember(ref, text, r);
      const warn = warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : " No warnings.";
      return done(r, `Uploaded ${library}/${sourceFile}(${member}) via mapepire.${warn}`);
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "compile_member",
  "Compile a source member and return whether it succeeded, the compiler listing, and structured errors. Built-in command per type; override with `command`.",
  {
    library: z.string(),
    sourceFile: z.string(),
    member: z.string(),
    targetLibrary: z.string().optional().describe("where the object is created; default *CURLIB. Pass a real library to also get structured EVFEVENT errors."),
    objectName: z.string().optional().describe("compiled object name; default = member"),
    command: z.string().optional().describe("full CL compile command override"),
    type: z.string().optional().describe("override the auto-detected member type, e.g. RPGLE"),
    server: serverArg,
  },
  async ({ server, ...opts }, extra) => {
    const r = makeReporter(mcp, extra, "compile_member");
    try {
      const be = await getBackend(server);
      const res = await be.compile(opts, r);
      const errs = res.errors.map((e) => `  [sev ${e.severity}]${e.line ? ` line ${e.line}` : ""} ${e.msgId ?? ""}: ${e.text}`).join("\n");
      const text =
        `Command: ${res.command}\n` +
        `Status: ${res.success ? "SUCCESS" : "FAILED"}  Transport: mapepire  Errors: ${res.errors.length}\n` +
        (errs ? `\n${errs}\n` : "") +
        (res.messages ? `\n--- messages ---\n${res.messages}\n` : "") +
        (res.listing ? `\n--- listing ---\n${res.listing}` : "");
      return done(r, text, true);
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "list_servers",
  "List the configured IBM i servers you can target with the `server` parameter. The default server is `.env`; each additional `.env.<name>` file adds a server named <name>.",
  {},
  async (_args, extra) => {
    const r = makeReporter(mcp, extra, "list_servers");
    try {
      const servers = listServers();
      const text = servers.length
        ? `Configured servers:\n${servers.map((s) => `- ${s}${s === "default" ? " (.env)" : ` (.env.${s})`}`).join("\n")}`
        : "No env files found. Create a .env (default server) or .env.<name> files.";
      // This tool doubles as the diagnostics surface for the progress plumbing.
      const diag = `\n\nProgress support: the client ${r.hasToken ? "sent" : "did not send"} a progressToken with this call.`;
      return done(r, text + diag);
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

async function main() {
  await mcp.connect(new StdioServerTransport());
  console.error("[ibm-i-source] MCP server ready on stdio");
}
async function shutdown() {
  await Promise.all([...backends.values()].map((b) => b.close().catch(() => {})));
  process.exit(0);
}
process.on("SIGINT", shutdown).on("SIGTERM", shutdown);
main().catch((e) => { console.error(e); process.exit(1); });
