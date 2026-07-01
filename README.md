# ibm-i-source-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant like Claude Code direct
access to your **IBM i source members** (RPG, SQLRPGLE, CLLE, DDS). You can find code by describing
what it does, read it as clean UTF-8, edit it locally, then upload it back and compile it, all from
your MCP client.

For years the routine has been to download raw EBCDIC, run a conversion script, and only then read
the source. This server removes those steps. It connects straight to the box and hands back normal
Unicode text, with all the CCSID conversion done for you.

It talks to the IBM i over [mapepire](https://mapepire-ibmi.github.io/), the SQL / Db2 for i service
on port 8076. That is the same connection stack Code for IBM i uses. The client is pure Node, so
there is nothing to install on Windows.

## Requirements

- Node 18 or newer on the client.
- `mapepire-server` running on the IBM i (`yum install mapepire-server`, port 8076).
- A user profile with authority to the source libraries. Uploading and compiling also need write authority to the target objects.

## Install

All settings live in a `.env` file. Create it, install the server, then register it with Claude Code.

### 1. Get the code and build

```sh
git clone https://github.com/SH4RKKK/ibm-i-source-mcp && cd ibm-i-source-mcp
npm install && npm run build
```

### 2. Create your .env

```sh
cp .env.example .env
```

Then fill in the required values. The optional ones are listed under Configuration.

```
IBMI_HOST=your.ibmi.host
IBMI_USER=YOURUSER
IBMI_PASSWORD=yourpassword
```

### 3. Register with Claude Code

```sh
claude mcp add ibmi-source --scope user -- node "$PWD/dist/index.js"
```

Restart Claude Code, or run `/mcp`, and the tools show up. The server reads the `.env` from its own
folder, so it works no matter which directory Claude Code launches it from.

To debug it on its own, use the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.

Once the package is published to npm you can run it with `npx -y ibm-i-source-mcp` instead of building
from source. In that case keep your `.env` in a folder of your choice and set that folder as the
server's working directory in your MCP config, since an npx package has no project folder of its own.

## Configuration

All configuration lives in a `.env` file. The server looks for `.env` in the folder it is launched
from, then in its own install folder. A real environment variable, if one is set, takes precedence
over the file.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `IBMI_HOST` | yes | | IBM i host or IP |
| `IBMI_USER` | yes | | user profile |
| `IBMI_PASSWORD` | yes | | password |
| `IBMI_MAPEPIRE_PORT` | no | `8076` | mapepire daemon port |
| `IBMI_NAMING` | no | `system` | SQL naming, `system` or `sql` |
| `IBMI_ALLOW_SELF_CERT` | no | `true` | accept mapepire self-signed cert |
| `IBMI_SOURCE_FILE_CCSID` | no | `37` | EBCDIC page used for CCSID 65535 source columns |
| `IBMI_LOCAL_DIR` | no | `ibmi-src` | where local copies are written |

## Tools

### Discover

- **`list_source_files`**: give it a library and it returns the source physical files (like `QRPGLESRC` or `QDDSSRC`) with their text descriptions.
- **`list_members`**: give it a library, and optionally a `sourceFile` or `memberType`, and it lists every member with its name, type, and text description, the way you would browse in PDM or RDi.
- **`search_source`**: give it a library and a `searchTerm`. A member turns up if the term is in its name, its text description, or its code, and each result tells you which. This lets you find a member by its purpose, for example a Dutch word like `afdeling`, even when that word never appears in the source itself.

### Read

- **`read_source_member`**: give it a library, source file, and member. It returns the source as clean UTF-8 and saves an editable local copy at `ibmi-src/<lib>/<file>/<member>.<ext>`, along with metadata like type, ccsid, line count, and last changed date.

### Change

- **`upload_source_member`**: give it a library, source file, and member, and optionally a `localPath` or `content`. It writes the edited copy back into the member, defaulting to the local copy that `read_source_member` saved. If a line is longer than the source record length, it tells you the line was truncated.
- **`compile_member`**: give it a library, source file, and member, and optionally `targetLibrary` (defaults to `*curlib`), `objectName`, `command`, or `type`. It compiles the member and returns whether it succeeded, the compiler spool listing, and the structured errors parsed from the EVFEVENT event file. It picks a `crt` command based on the source type, and you can override that with `command`. Pass a real `targetLibrary` if you want the structured errors.

## Example workflow

Say you ask: "find the display file that shows department information, and note the app is in Dutch."

1. `search_source(library, "afdeling", memberType: "DSPF")` turns up the DDS member whose text description reads "Onderhoud afdelingsgegevens".
2. `read_source_member(...)` brings the DDS down locally as UTF-8 so the assistant can read it.
3. You edit the local copy, by hand or with the assistant's help.
4. `upload_source_member(...)` sends the change back into the member.
5. `compile_member(..., targetLibrary: "DEVLIB")` reports SUCCESS, or FAILED with the listing and the exact message IDs and line numbers to fix.

## How it works

- **Read**: it runs `ovrdbf` to point a job-scoped alias at the member, selects `srcdta` (casting to `IBMI_SOURCE_FILE_CCSID` when the column is CCSID 65535), and joins the lines. A single serialized SQL job keeps that job-scoped override from getting tangled up with other calls.
- **Discover**: members and their text come from `qsys2.object_statistics` joined with a lateral `qsys2.partition_statistics` call, and source files come from `qsys2.systables` where `file_type = 'S'`. Search adds a per-member `like` scan of `srcdta` for code hits.
- **Upload**: it runs `clrpfm`, then inserts the SRCSEQ and SRCDTA rows back through the alias in chunks. If a line is longer than the record length, it is truncated and reported rather than dropped silently.
- **Compile**: it runs the `crt` command with `option(*eventf)`, reads the held spool file through `qsys2.spooled_file_info` and `systools.spooled_file_data`, and parses the EVFEVENT file into structured errors with severity, line, message id, and text.

## Notes and limits

- Search makes one SQL round-trip per member, so scope it with a library and source file when you can.
- The EVFEVENT parser is reliable on message id, severity, and text, and best-effort on line numbers.
- `npm run check` builds the project and runs the self-checks (`node:test`).

## Project layout

```
src/
  index.ts     MCP server and tool registration
  config.ts    .env and env-var loader
  mapepire.ts  mapepire backend (read, search, list, write, compile over SQL)
  compile.ts   compile command templates and EVFEVENT parser
  util.ts      type-to-extension map, local-copy writer, text match
  types.ts     shared types and the SourceBackend interface
  selfcheck.ts asserts for the parse and config logic
```

## Acknowledgements

This project was written from scratch, but it builds on the work of others:

- **[IBM/ibmi-mcp-server](https://github.com/IBM/ibmi-mcp-server)** (Apache-2.0): a reference for the MCP and mapepire server architecture. No code was copied.
- **[codefori/vscode-ibmi](https://github.com/codefori/vscode-ibmi)** (MIT): a reference for the Db2 for i SQL patterns used to read members, list source, and drive compiles.
- **[mapepire](https://mapepire-ibmi.github.io/)** (Apache-2.0): the Db2 for i client this server talks over.

Thanks to those teams and the wider IBM i community.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The dependencies keep their own licenses
(Apache-2.0, MIT, BSD-2-Clause), all of which are compatible with Apache-2.0.
