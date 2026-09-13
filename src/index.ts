#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { listServers, loadProfileFor } from "./config.js";
import { MapepireBackend } from "./mapepire.js";
import { makeReporter, type ToolExtra, type ToolReporter } from "./report.js";
import { findLocalCopy, typeFromPath, writeLocalCopy } from "./util.js";

// --- runtime ---
console.log = (...a: unknown[]) => console.error(...a); // stdout is the JSON-RPC channel
process.on("unhandledRejection", (r) => console.error("[ibm-i-source] unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("[ibm-i-source] uncaughtException:", e));

// --- constants ---
const LOCAL_DIR = process.env.IBMI_LOCAL_DIR || "ibmi-src";
const serverArg = z.string().optional().describe("which IBM i to use, named by a .env.<name> file. Omit for the default .env server (see list_servers)");
const mcp = new McpServer({ name: "ibm-i-source", version: "0.6.0" }, { capabilities: { logging: {} } });

// --- helpers ---
const done = (text: string) => ({ content: [{ type: "text" as const, text: text.trimEnd() }] });
const backends = new Map<string, MapepireBackend>();

function getBackend(server?: string): MapepireBackend {
  const key = server?.toLowerCase() || "default";
  let be = backends.get(key);
  if (!be) {
    be = new MapepireBackend(loadProfileFor(server));
    backends.set(key, be);
  }
  return be;
}

function tool<Args extends ZodRawShapeCompat>(
  name: string,
  description: string,
  inputSchema: Args,
  run: (args: ShapeOutput<Args>, r: ToolReporter) => Promise<string>,
): void {
  const cb = (async (args: ShapeOutput<Args>, extra: ToolExtra) => {
    const r = makeReporter(mcp, extra, name);
    try {
      return done(await run(args, r));
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  }) as ToolCallback<Args>;
  mcp.registerTool(name, { description, inputSchema }, cb);
}

// --- tools ---
tool(
  "read_source_member",
  "Download an IBM i source member as clean UTF-8 into a local editable copy, plus a pristine backup. Returns the saved paths and metadata, not the source text: read the saved file to see the code.",
  {
    library: z.string().describe("library / schema, e.g. MYLIB"),
    sourceFile: z.string().describe("source physical file, e.g. QRPGLESRC"),
    member: z.string().describe("member name, e.g. MYPGM"),
    server: serverArg,
  },
  async ({ library, sourceFile, member, server }, r) => {
    const be = getBackend(server);
    const { content, meta } = await be.readMember({ library, sourceFile, member }, r);
    r.step("saving the local copy");
    const { path, backup } = writeLocalCopy(LOCAL_DIR, { library, sourceFile, member }, meta.type, content);
    r.log("info", `read ${library}/${sourceFile}(${member}): ${meta.lineCount} lines saved to ${path}`);
    return (
      `Saved: ${path}\n` +
      `Backup: ${backup}\n` +
      `Type: ${meta.type}  CCSID: ${meta.ccsid}  Lines: ${meta.lineCount}` +
      (meta.lastChanged ? `  Changed: ${meta.lastChanged}` : "") +
      `  Transport: mapepire\n\n` +
      `The source is in the saved file, read it from there.`
    );
  },
);

tool(
  "search_source",
  "Grep the CODE of the members in a library, returning the matching lines with their sequence numbers. Still the slow tool, so scope it with sourceFile or memberType. To find a member by its name or its TEXT description instead, use list_members with a filter, which is a single query.",
  {
    library: z.string().describe("library to search"),
    searchTerm: z.string().describe("literal string to find in the source lines (not a regex)"),
    sourceFile: z.string().optional().describe("limit to one source file, e.g. QDDSSRC"),
    memberType: z.string().optional().describe("limit to a member type, e.g. DSPF, RPGLE"),
    caseSensitive: z.boolean().optional().describe("default false"),
    maxResults: z.number().int().positive().optional().describe("default 200"),
    server: serverArg,
  },
  async ({ server, ...opts }, r) => {
    const be = getBackend(server);
    const { matches, truncated } = await be.searchSource(opts, r);
    const lines = matches.map(
      (m) => `${m.library}/${m.sourceFile}(${m.member})${m.type ? ` [${m.type}]` : ""} ${m.seqNbr}: ${m.line}`,
    );
    const head = `${matches.length} match(es)${truncated ? ` (truncated at maxResults)` : ""}\n\n`;
    return head + (lines.join("\n") || "(no matches)");
  },
);

tool(
  "list_libraries",
  "List libraries (schemas) on the IBM i with their text descriptions, so you can discover where source lives before drilling in with list_source_files and list_members. Lists user libraries by default. Pass filter to narrow by a substring of the library name or its description, e.g. a project or application name.",
  {
    filter: z.string().optional().describe("substring to match against the library name or its text, ignoring case. Omit to list all user libraries."),
    includeSystem: z.boolean().optional().describe("also include the IBM Q* system libraries (default false, user libraries only)"),
    server: serverArg,
  },
  async ({ filter, includeSystem, server }, r) => {
    const be = getBackend(server);
    const libs = await be.listLibraries(filter, includeSystem, r);
    const lines = libs.map((l) => `${l.name}${l.text ? `: ${l.text}` : ""}`);
    const head = `${libs.length} librar${libs.length === 1 ? "y" : "ies"}${filter ? ` matching "${filter}"` : ""}:\n\n`;
    return head + (lines.join("\n") || "(none)");
  },
);

tool(
  "manage_library_list",
  "View or change the connection's library list. `show` returns the current list (SYSTEM/PRODUCT/CURRENT/USER portions). `add` and `remove` add or drop one library (ADDLIBLE/RMVLIBLE), `set_current` sets the current library (CHGCURLIB), and `replace` sets the whole user portion (CHGLIBL). Changes last for the session and are used by later compiles, like adding a library on the green screen. It only changes the job's library list, never objects or data. Use this when a compile needs a library that is not on the sign on list. The change actions are disabled when IBMI_READ_ONLY is set, while `show` always works.",
  {
    action: z.enum(["show", "add", "remove", "set_current", "replace"]).describe("show the list, add/remove one library, set the current library, or replace the whole user portion"),
    library: z.string().optional().describe("the library for add, remove, or set_current"),
    libraries: z.array(z.string()).optional().describe("the full user library list for replace, in search order (first = highest priority)"),
    position: z.enum(["first", "last"]).optional().describe("for add: put it first (searched first) or last (default)"),
    currentLibrary: z.string().optional().describe("for replace: also set the current library"),
    server: serverArg,
  },
  async ({ action, library, libraries, position, currentLibrary, server }, r) => {
    const be = getBackend(server);
    const entries = action === "show"
      ? await be.readLibraryList(r)
      : await be.changeLibraryList(action, { library, libraries, position, currentLibrary }, r);
    const body = entries.map((e) => `  ${e.portion.padEnd(8)} ${e.library}`).join("\n");
    const head = action === "show" ? "Library list:" : `Done (${action}). Library list now:`;
    return `${head}\n\n${body || "(empty)"}`;
  },
);

tool(
  "list_source_files",
  "List the source physical files in a library (e.g. QRPGLESRC, QDDSSRC) with their text descriptions. Use to explore where source lives before listing members.",
  { library: z.string(), server: serverArg },
  async ({ library, server }, r) => {
    const be = getBackend(server);
    const files = await be.listSourceFiles(library, r);
    const lines = files.map((f) => `${f.name}${f.text ? `: ${f.text}` : ""}`);
    return `${files.length} source file(s) in ${library}:\n\n` + (lines.join("\n") || "(none)");
  },
);

tool(
  "list_members",
  "Browse members in a library (like PDM/RDi): each member with its name, type, and TEXT description. Omit sourceFile to list across all source files. Pass filter to find a member by its purpose without reading any code: it matches a substring of the member name or its TEXT description in one query, so it is the fast way in (e.g. a Dutch word like 'afdeling'). Use search_source only when you need to match the code itself.",
  {
    library: z.string(),
    sourceFile: z.string().optional().describe("limit to one source file, e.g. QDDSSRC"),
    memberType: z.string().optional().describe("limit to a type, e.g. DSPF"),
    filter: z.string().optional().describe("substring to match against the member name or its text description, ignoring case. Omit to list everything."),
    server: serverArg,
  },
  async ({ library, sourceFile, memberType, filter, server }, r) => {
    const be = getBackend(server);
    const members = await be.listMembers(library, sourceFile, memberType, filter, r);
    const lines = members.map((m) => `${m.sourceFile}(${m.name}) [${m.type || "?"}]${m.text ? `: ${m.text}` : ""}`);
    const head = `${members.length} member(s) in ${library}${sourceFile ? `/${sourceFile}` : ""}${filter ? ` matching "${filter}"` : ""}:\n\n`;
    return head + (lines.join("\n") || "(none)");
  },
);

tool(
  "upload_source_member",
  "Upload a local file into a source member on the IBM i. By default this reads, modifies and writes back a member that already exists, defaulting to the copy read_source_member wrote. For brand new development, where the member does not exist yet, pass create: true and the member is added first (addpfm) with the right source type. Creation is opt in so a mistyped member name cannot leave a stray member behind in a customer library.",
  {
    library: z.string(),
    sourceFile: z.string(),
    member: z.string(),
    localPath: z.string().optional().describe("path to the edited file, defaults to the local copy from read_source_member"),
    content: z.string().optional().describe("upload this text directly instead of reading a file"),
    create: z.boolean().optional().describe("create the member first if it does not exist yet (addpfm). Default false: uploading into a member that is not there fails instead, so a typo cannot create one."),
    memberType: z.string().optional().describe("source type used when creating, e.g. DSPF, SQLRPGLE, RPGLE, PF, CLLE. Defaults to the local file's extension, since read_source_member names copies <member>.<type>. Required when creating from `content`. Worth passing explicitly: the type decides which command compile_member picks."),
    text: z.string().optional().describe("member text description, shown in PDM next to the member. Used only when creating. Max 50 characters."),
    server: serverArg,
  },
  async ({ library, sourceFile, member, localPath, content, create, memberType, text, server }, r) => {
    const be = getBackend(server);
    const ref = { library, sourceFile, member };
    let body = content;
    let sourcePath: string | undefined;
    if (body === undefined) {
      sourcePath = localPath ?? findLocalCopy(LOCAL_DIR, ref);
      r.step(`reading the local file ${sourcePath}`);
      body = readFileSync(sourcePath, "utf8");
    }
    // read_source_member names copies <member>.<source type>, so the type is in the filename
    const type = memberType ?? (sourcePath ? typeFromPath(sourcePath) : undefined);
    const { warnings, created } = await be.writeMember(ref, body, r, { create, memberType: type, text });
    const warn = warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : " No warnings.";
    const head = created
      ? `Created a new member ${library}/${sourceFile}(${member}) with source type ${type}, then uploaded it via mapepire.`
      : `Uploaded ${library}/${sourceFile}(${member}) via mapepire.`;
    return `${head}${warn}`;
  },
);

tool(
  "compile_member",
  "Compile a source member and return whether it succeeded, the compiler listing, and structured errors. Built-in command per type, override with `command`.",
  {
    library: z.string(),
    sourceFile: z.string(),
    member: z.string(),
    targetLibrary: z.string().optional().describe("where the object is created, default *curlib. Pass a real library to also get structured EVFEVENT errors."),
    objectName: z.string().optional().describe("compiled object name, defaults to the member name"),
    command: z.string().optional().describe("full CL compile command override"),
    type: z.string().optional().describe("override the detected member type, e.g. RPGLE"),
    server: serverArg,
  },
  async ({ server, ...opts }, r) => {
    const be = getBackend(server);
    const res = await be.compile(opts, r);
    const errs = res.errors.map((e) => `  [sev ${e.severity}]${e.line ? ` line ${e.line}` : ""} ${e.msgId ?? ""}: ${e.text}`).join("\n");
    return (
      `Command: ${res.command}\n` +
      `Status: ${res.success ? "SUCCESS" : "FAILED"}  Transport: mapepire  Errors: ${res.errors.length}\n` +
      (errs ? `\n${errs}\n` : "") +
      (res.messages ? `\n--- messages ---\n${res.messages}\n` : "") +
      (res.listing ? `\n--- listing ---\n${res.listing}` : "")
    );
  },
);

tool(
  "list_servers",
  "List the configured IBM i servers you can target with the `server` parameter. The default server is `.env`, and each additional `.env.<name>` file adds a server named <name>.",
  {},
  async () => {
    const servers = listServers();
    return servers.length
      ? `Configured servers:\n${servers.map((s) => `- ${s}${s === "default" ? " (.env)" : ` (.env.${s})`}`).join("\n")}`
      : "No env files found. Create a .env (default server) or .env.<name> files.";
  },
);

// --- bootstrap ---
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
