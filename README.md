# ibm-i-source-mcp

MCP server that reads **IBM i source members** (RPG / SQLRPGLE / CLLE / DDS) as clean UTF-8,
lets you edit them locally, then **uploads and compiles** them back on the box — feeding
source into review workflows without the manual *download raw EBCDIC → convert → read* loop.

Talks to the IBM i over **mapepire** (SQL, port 8076). CCSID/EBCDIC conversion is handled for you.

Four tools:

- **`read_source_member`** — `library`, `sourceFile`, `member` → returns the source as UTF-8 and writes `ibmi-src/<lib>/<file>/<member>.<ext>`.
- **`search_source`** — `library` (+ optional `sourceFile`, `memberType`, `caseSensitive`, `maxResults`) → matching lines, FNDSTRPDM-style.
- **`upload_source_member`** — `library`, `sourceFile`, `member` (+ optional `localPath`/`content`) → writes the edited copy back into the member.
- **`compile_member`** — `library`, `sourceFile`, `member` (+ optional `targetLibrary`, `objectName`, `command`, `type`) → compiles and returns SUCCESS/FAILED, the compiler spool listing, and structured EVFEVENT errors.

## Prerequisite

**`mapepire-server` must be running on the IBM i** (`yum install mapepire-server`, port 8076).
There is no SSH fallback — if you're developing on IBM i you should be on mapepire anyway
(it's what Code for IBM i / VS Code uses).

## Setup

```sh
npm install
npm run build
```

Create `.env` (copy `.env.example`) — the whole config lives here:

```
IBMI_HOST=ibmi.example.com
IBMI_USER=MYUSER
IBMI_PASSWORD=...
# optional: IBMI_MAPEPIRE_PORT, IBMI_NAMING, IBMI_ALLOW_SELF_CERT,
#           IBMI_SOURCE_FILE_CCSID, IBMI_LOCAL_DIR
```

`.env` is git-ignored, and it's read from the server's install folder, so it's found no
matter which directory Claude Code launches the server from.

## Install

Requires **Node 18+** and **mapepire-server running on the IBM i** (port 8076).

### Claude Code (recommended)

```sh
claude mcp add ibmi-source --scope user \
  -e IBMI_HOST=your.ibmi.host \
  -e IBMI_USER=YOURUSER \
  -e IBMI_PASSWORD=yourpassword \
  -- npx -y ibm-i-source-mcp
```

That downloads and runs the server via `npx` — no clone needed. Restart Claude Code (or `/mcp`)
and the tools appear. Any `IBMI_*` var from `.env.example` can be passed with `-e`.

### Or via `.mcp.json`

```jsonc
{ "mcpServers": { "ibmi-source": {
    "command": "npx",
    "args": ["-y", "ibm-i-source-mcp"],
    "env": { "IBMI_HOST": "your.ibmi.host", "IBMI_USER": "YOURUSER", "IBMI_PASSWORD": "yourpassword" }
} } }
```

### From source (development)

```sh
git clone https://github.com/SH4RKKK/ibm-i-source-mcp && cd ibm-i-source-mcp
npm install && npm run build
claude mcp add ibmi-source --scope user -- node "$PWD/dist/index.js"
```

Standalone / debugging: `npx @modelcontextprotocol/inspector node dist/index.js`.

## How it works

- **Read:** `ovrdbf` a job-scoped alias at the member → `select srcdta` (cast to `IBMI_SOURCE_FILE_CCSID` when the column is CCSID 65535) → join lines. A single serialized SQL job keeps the `*job`-scoped override safe.
- **Search:** enumerate members via `qsys2.object_statistics`/`syspartitionstat`, then `like` per member. O(members) round-trips — scope with `library` + `sourceFile`.
- **Upload:** `clrpfm` + chunked `insert` of SRCSEQ/SRCDTA rows through the alias. Lines longer than the source record length are truncated **with a warning**.
- **Compile:** run the `crt*` command (built-in template per type, or your `command` override) with `option(*eventf)`, read the held spool via `qsys2.spooled_file_info` + `systools.spooled_file_data`, and parse EVFEVENT for structured errors. Pass a real `targetLibrary` (not `*CURLIB`) to get the structured errors.

## Notes / limits

- `IBMI_SOURCE_FILE_CCSID` (default 37) is the target for no-conversion (CCSID 65535) source columns. Bump it if a box stores source in another EBCDIC page.
- The EVFEVENT `ERROR`-record parser is best-effort on line numbers (msgId/severity/text are reliable); verify against a real failing compile.
- `npm run check` builds and runs the self-checks (`node:test`).

## Layout

```
src/
  index.ts     MCP server, tool registration
  config.ts    .env loader (single profile)
  mapepire.ts  mapepire backend (read/search/write/compile over SQL)
  compile.ts   compile command templates + EVFEVENT parser
  util.ts      type→extension, local-copy writer
  types.ts     shared types + SourceBackend interface
  selfcheck.ts asserts for the parse/config logic
```
