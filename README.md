# ibm-i-source-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant (Claude Code, etc.)
first-class access to **IBM i source members** — RPG, SQLRPGLE, CLLE, DDS. Discover code by its
purpose, read it as clean UTF-8, edit it locally, then **upload and compile** it back on the box
and read the compiler results.

It replaces the old manual loop — *download raw EBCDIC → convert with a script → read* — with a
direct, CCSID-correct pipeline. All conversion is handled for you; source comes back as normal
Unicode text.

Talks to the IBM i over **[mapepire](https://mapepire-ibmi.github.io/)** (SQL / Db2 for i, port 8076) —
the same connection stack Code for IBM i uses. Pure Node client; nothing to install on Windows.

## Requirements

- **Node 18+** on the client.
- **`mapepire-server` running on the IBM i** (`yum install mapepire-server`, port 8076).
- A user profile with authority to the source libraries. Compiling/uploading needs write authority to the targets.

## Install

### Claude Code (recommended)

```sh
claude mcp add ibmi-source --scope user \
  -e IBMI_HOST=your.ibmi.host \
  -e IBMI_USER=YOURUSER \
  -e IBMI_PASSWORD=yourpassword \
  -- npx -y ibm-i-source-mcp
```

`npx` downloads and runs the server — no clone, no build. Restart Claude Code (or run `/mcp`) and
the tools appear. Any variable from [Configuration](#configuration) can be passed with `-e`.

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
cp .env.example .env      # fill in IBMI_HOST / IBMI_USER / IBMI_PASSWORD
claude mcp add ibmi-source --scope user -- node "$PWD/dist/index.js"
```

Debug it standalone with the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.

## Configuration

Config is read from environment variables (via `-e` flags / the `env` block above), or from a
git-ignored `.env` file when running from source. `.env` is loaded from the server's own install
folder, so it's found no matter where the server is launched.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `IBMI_HOST` | ✅ | — | IBM i host / IP |
| `IBMI_USER` | ✅ | — | user profile |
| `IBMI_PASSWORD` | ✅ | — | password |
| `IBMI_MAPEPIRE_PORT` | | `8076` | mapepire daemon port |
| `IBMI_NAMING` | | `system` | SQL naming: `system` or `sql` |
| `IBMI_ALLOW_SELF_CERT` | | `true` | accept mapepire self-signed cert |
| `IBMI_SOURCE_FILE_CCSID` | | `37` | EBCDIC page used for CCSID-65535 source columns |
| `IBMI_LOCAL_DIR` | | `ibmi-src` | where local copies are written |

## Tools

**Discover**
- **`list_source_files`** — `library` → the source physical files (e.g. `QRPGLESRC`, `QDDSSRC`) with their text descriptions.
- **`list_members`** — `library` (+ optional `sourceFile`, `memberType`) → every member with its **name, type, and TEXT description**, like browsing PDM/RDi.
- **`search_source`** — `library`, `searchTerm` (+ optional `sourceFile`, `memberType`, `caseSensitive`, `maxResults`) → a member surfaces if the term is in its **name**, its **TEXT description**, or its **code**, and each hit says which. Lets you find a member by its *purpose* (e.g. a Dutch word like `afdeling`) even when the word isn't in the source itself.

**Read**
- **`read_source_member`** — `library`, `sourceFile`, `member` → returns the source as clean UTF-8 and saves an editable local copy at `ibmi-src/<lib>/<file>/<member>.<ext>`, plus metadata (type, ccsid, line count, last-changed).

**Change**
- **`upload_source_member`** — `library`, `sourceFile`, `member` (+ optional `localPath` / `content`) → writes the edited copy back into the member. Defaults to the local copy from `read_source_member`. Reports any lines truncated to the source record length.
- **`compile_member`** — `library`, `sourceFile`, `member` (+ optional `targetLibrary` [default `*CURLIB`], `objectName`, `command`, `type`) → compiles and returns **SUCCESS/FAILED**, the compiler **spool listing**, and **structured errors** parsed from the EVFEVENT event file. Built-in `crt*` command per source type, overridable with `command`. Pass a real `targetLibrary` to get the structured errors.

## Example workflow

> "Find the display file that shows department info — it's a Dutch app."

1. `search_source(library, "afdeling", memberType: "DSPF")` → surfaces the DDS member whose TEXT description is *"Onderhoud afdelingsgegevens"*.
2. `read_source_member(...)` → the DDS lands locally as UTF-8; the assistant reads it.
3. Edit the local copy (by hand or with the assistant).
4. `upload_source_member(...)` → the change goes back into the member.
5. `compile_member(..., targetLibrary: "DEVLIB")` → `SUCCESS`, or `FAILED` with the listing and the exact `RNF…` errors and line numbers to fix.

## How it works

- **Read:** `ovrdbf` a job-scoped alias at the member → `select srcdta` (cast to `IBMI_SOURCE_FILE_CCSID` when the column is CCSID 65535) → join lines. A single serialized SQL job keeps the `*job`-scoped override safe from interleaving.
- **Discover:** members and their TEXT come from `qsys2.object_statistics` + a lateral `qsys2.partition_statistics` call; source files from `qsys2.systables` (`file_type = 'S'`). Search adds a per-member `like` scan of `srcdta` for code hits.
- **Upload:** `clrpfm` + chunked `insert` of SRCSEQ/SRCDTA rows through the alias. Over-length lines are truncated **with a warning** — never silently dropped.
- **Compile:** run the `crt*` command with `option(*eventf)`, read the held spool via `qsys2.spooled_file_info` + `systools.spooled_file_data`, and parse the EVFEVENT file for structured `{severity, line, msgId, text}` errors.

## Notes / limits

- Search is O(members) SQL round-trips — scope with `library` + `sourceFile` for speed.
- The EVFEVENT `ERROR`-record parser is best-effort on line numbers (msgId/severity/text are reliable).
- `npm run check` builds and runs the self-checks (`node:test`).

## Project layout

```
src/
  index.ts     MCP server, tool registration
  config.ts    .env / env-var loader
  mapepire.ts  mapepire backend (read/search/list/write/compile over SQL)
  compile.ts   compile command templates + EVFEVENT parser
  util.ts      type→extension, local-copy writer, text match
  types.ts     shared types + SourceBackend interface
  selfcheck.ts asserts for the parse/config logic
```

## Acknowledgements

This is an independent project, written from scratch, but it stands on the shoulders of prior work:

- **[IBM/ibmi-mcp-server](https://github.com/IBM/ibmi-mcp-server)** (Apache-2.0) — reference for the MCP + mapepire server architecture. No code was copied.
- **[codefori/vscode-ibmi](https://github.com/codefori/vscode-ibmi)** (MIT) — reference for the Db2-for-i SQL patterns used to read members, list source, and drive compiles.
- **[mapepire](https://mapepire-ibmi.github.io/)** (Apache-2.0) — the Db2 for i client this server talks over.

Grateful to those teams and the IBM i community.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Dependencies retain their own licenses
(Apache-2.0, MIT, BSD-2-Clause), all compatible with Apache-2.0.
