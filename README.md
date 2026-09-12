# ibm-i-source-mcp

[![npm](https://img.shields.io/npm/v/ibm-i-source-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/ibm-i-source-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-3c873a?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](package.json)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-%5E1.19-6f42c1)](https://github.com/modelcontextprotocol/typescript-sdk)
[![IBM i](https://img.shields.io/badge/IBM%20i-Db2%20for%20i-052fad?logo=ibm&logoColor=white)](https://mapepire-ibmi.github.io/)

An [MCP](https://modelcontextprotocol.io) server that lets AI tools like Claude Code work directly
with the source members on an IBM i, the RPG, SQLRPGLE, CLLE, and DDS that live on the box. You can
find code by describing what it does, read it as clean UTF-8, edit it locally, then send it back and
compile it, all from your MCP client.

Most IBM i source never made it into a Git repository. It lives on the box, in source physical files,
which is also where it compiles and runs. Green screen tools and the Code for IBM i extension both
read it there, so that has never been a problem. It is a problem for an AI assistant, which can only
help with code it can actually read. This server gives it that access.

It reaches Db2 for i through [mapepire](https://mapepire-ibmi.github.io/), the same SQL engine Code for
IBM i uses. It connects the same way Code for IBM i does too: it opens an SSH session, uploads the
bundled mapepire server, and runs it in single mode over that session. There is no daemon to install on
the IBM i and no extra port to open. If you can SSH to the box, this works. The client is pure Node, so
there is nothing to build on Windows either.

## Example workflow

Say you ask: "find the display file that shows department information, and note the app is in Dutch."

1. `list_libraries(filter: "adm")` finds the candidate libraries when you do not already know the name, so the assistant can pick where to look on its own.
2. `list_members(library, filter: "afdeling", memberType: "DSPF")` turns up the DDS member whose text description reads "Onderhoud afdelingsgegevens", in one query. Only if the catalog comes up empty is `search_source` worth the scan.
3. `read_source_member(...)` brings the DDS down locally as UTF-8 so the assistant can read it.
4. You edit the local copy, by hand or with the assistant's help.
5. `upload_source_member(...)` sends the change back into the member.
6. `compile_member(..., targetLibrary: "DEVLIB")` reports SUCCESS, or FAILED with the listing and the exact message IDs and line numbers to fix.

## Requirements

- Node 18 or newer on the client.
- SSH access to the IBM i (port 22, already on by default) and a Java runtime on the box (already there
  on any system running Db2). Nothing else to install on the IBM i.
- A user profile with authority to the source libraries. Uploading and compiling also need write authority to the target objects.

## Install

Run it straight from npm with npx (no build), or clone and build from source. Either way, all
settings live in a `.env` file (see Configuration).

### Option A: from npm

Register the server with Claude Code:

```sh
claude mcp add ibmi-source --scope user -- npx -y ibm-i-source-mcp
```

Or install it once and point at the binary:

```sh
npm install -g ibm-i-source-mcp
claude mcp add ibmi-source --scope user -- ibm-i-source-mcp
```

Then create a `.env` with your connection details in `~/.ibm-i-source-mcp/` (create the folder if it
does not exist), and restart Claude Code or run `/mcp`. A package installed from npm or run with `npx`
has no stable folder of its own (the npx copy lives in a cache that is wiped on every update), so this
home folder is the reliable place to keep credentials. See Configuration for the full search order.

### Option B: from source

```sh
git clone https://github.com/SH4RKKK/ibm-i-source-mcp && cd ibm-i-source-mcp
npm install && npm run build
cp .env.example .env
claude mcp add ibmi-source --scope user -- node "$PWD/dist/index.js"
```

Fill in the required values in your `.env` (the optional ones are under Configuration):

```
IBMI_HOST=your.ibmi.host
IBMI_USER=YOURUSER
IBMI_PASSWORD=yourpassword
```

Restart Claude Code or run `/mcp` and the tools show up. Built from source, the server reads the `.env`
from its own folder, so it works no matter which directory Claude Code launches it from.

## Configuration

All configuration lives in a `.env` file. The server looks for it in these places, first match wins:

1. a folder you name yourself in `IBMI_MCP_CONFIG_DIR`. Set it on the MCP server entry rather than in
   your shell, because your MCP client launches the server, not you:
   `claude mcp add ibmi-source --env IBMI_MCP_CONFIG_DIR=/path/to/folder -- npx -y ibm-i-source-mcp`
2. `~/.ibm-i-source-mcp/`, which is where it should go for an npm or npx install
3. the server's own install folder, next to `dist/`, if you cloned and built from source

A real environment variable, if one is set, always takes precedence over a value in the file.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `IBMI_HOST` | yes | | IBM i host or IP |
| `IBMI_USER` | yes | | user profile |
| `IBMI_PASSWORD` | yes | | password |
| `IBMI_SSH_PORT` | no | `22` | SSH port on the IBM i |
| `IBMI_SOURCE_FILE_CCSID` | no | `37` | EBCDIC page used for CCSID 65535 source columns |
| `IBMI_LOCAL_DIR` | no | `ibmi-src` | where local copies are written |
| `IBMI_MAPEPIRE_JAR` | no | | path to a mapepire jar already on the box, instead of the bundled one |
| `IBMI_READ_ONLY` | no | `false` | `true` disables upload and compile (read, search, and list only) |
| `IBMI_BLOCKED_CL` | no | | extra CL verbs to refuse as a compile command, comma separated |

### Multiple servers

To work with more than one IBM i, add one env file per box next to `.env`. The name after `.env.` is
the server name.

```
.env          the default server
.env.PROD     a server named PROD
.env.DEV      a server named DEV
```

Each file holds the same variables as above for that box. You never type the server name yourself.
Every tool has an optional `server` argument and the assistant fills it in from what you say: ask it
to "read MYPGM on PROD" and it passes `server: "PROD"`, which loads `.env.PROD`. Say nothing about a
box and it uses `.env`. `list_servers` is how the assistant learns which names exist. Each server
gets its own connection, held open and reused, so switching between boxes mid conversation only costs
the first connect.

All `.env` and `.env.*` files are git-ignored, only `.env.example` is committed.

## Tools

### Discover

- **`list_libraries`**: the libraries on the box with their text descriptions. User libraries by default. `filter` narrows by name or description, `includeSystem` adds the IBM `Q*` libraries.
- **`list_source_files`**: the source physical files in a library, such as `QRPGLESRC` or `QDDSSRC`, with their descriptions.
- **`list_members`**: the members in a library with name, type and text description, like browsing in PDM. `filter` matches the name or the description in one query, which is how you find a member by what it does rather than what it is called. `sourceFile` and `memberType` narrow it further.
- **`search_source`**: greps the code of every member and returns the matching lines with their sequence numbers. Still the slow one, so scope it with `sourceFile` or `memberType` and try `list_members` with a filter first. The term is matched literally, never as a pattern. It runs `fndstrpdm`, so the box needs 5770WDS option 21 (Application Development ToolSet) installed.
- **`list_servers`**: the IBM i servers you have configured.

### Read

- **`read_source_member`**: downloads a member as clean UTF-8 to `ibmi-src/<lib>/<file>/<member>.<ext>`, where the extension is the member type. An untouched backup goes to `ibmi-src/.backup/` under the same tree and refreshes on every read, so the original is always recoverable. The result is the saved paths and the metadata, not the source text, so a large member does not flood the conversation.

### Library list

- **`manage_library_list`**: `show` returns the current list. `add`, `remove`, `set_current` and `replace` map to `ADDLIBLE`, `RMVLIBLE`, `CHGCURLIB` and `CHGLIBL`. One job serves the whole session, so a change sticks and later compiles use it. It only touches the job's library list, never objects or data. Use it when a compile needs a library the profile does not sign on with. The change actions honour `IBMI_READ_ONLY`, `show` always works.

### Change

- **`upload_source_member`**: writes an edited file back into a member, defaulting to the copy `read_source_member` saved. Lines longer than the record length are truncated and reported. `create: true` runs `addpfm` first for a member that does not exist yet. Creating is opt in, so a mistyped name fails and changes nothing rather than leaving a stray member behind in a customer library.
- **`compile_member`**: compiles a member and returns whether it succeeded, the spool listing, and the structured errors from the EVFEVENT file. It picks the `crt` command from the source type, and `command` overrides it. Pass a real `targetLibrary` to get the structured errors and to control where the object lands, since `*curlib` falls back to QGPL on a box with no current library.

## Progress and logging

Tools narrate while they run, so a slow box looks slow rather than hung.

Live updates go out as MCP [progress notifications](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress)
when the client asks for them, which Claude Code does: `scanned 250 of 947 member(s)`,
`uploading MYPGM: 1500/3200 lines`, and a MB bar while the jar uploads on first connect. Clients that
do not ask get the same messages as info level log notifications instead. Durable events, meaning
connections, uploads, truncated lines, compile results and every failure, also go to the client's log
tagged with the tool name, and everything is mirrored to stderr.

When nothing has happened for a few seconds a watchdog repeats the last step with the elapsed time
(`still working: compiling MYPGM (24s elapsed)`). The SSH connect gives up after 10 seconds and says
which of host not found, connection refused, no route, or sign on failed it was. If the session drops
mid call, the call fails fast instead of hanging and the next one reconnects.

## Security

This server logs into your IBM i over SSH and can read source, write source, and run compile
commands. Treat it like any tool that can act on the box.

- **Least privilege first.** The server has exactly the authority of the profile in the env file. Give it one with only the authority the work needs, never `QSECOFR`. Everything below is defense in depth.
- **Read only mode.** `IBMI_READ_ONLY=true` allows read, search and list only. Upload and compile are refused.
- **Compile command guard.** The `command` override on `compile_member` runs as CL, so only `crt*` commands are allowed and a list of destructive verbs is refused. `IBMI_BLOCKED_CL` extends that list. See `assertCompileCommandAllowed` in [src/compile.ts](src/compile.ts).
- **Network.** The SSH host key is not checked, so reach the box over a VPN or an internal network rather than the open internet.
- **Bundled jar integrity.** The mapepire jar is checked against a known SHA-256 before it is uploaded or run. The hash ships in the same package as the jar, so it catches corruption and local tampering, not a compromised release.
- **Prompt injection.** Source, text descriptions and compile listings come back to the model as untrusted text. A member could contain text that tries to steer the assistant into an unwanted upload or compile. The controls above limit what that could actually do.
- **Secrets.** Credentials live in `.env` and `.env.*`, which are git-ignored. Keep them readable only by you.

## Project layout

```
src/
  index.ts       tool registration and result formatting
  mapepire.ts    the backend: read, search, list, write and compile, all as SQL
  sshMapepire.ts SSH transport: runs the bundled mapepire jar in single mode
  config.ts      env file discovery and the Profile loader
  compile.ts     compile command templates, the CL guard, the EVFEVENT parser
  report.ts      progress and logging reporter (notifications, stall watchdog)
  util.ts        source type to extension, SQL escaping, local copy writer
  types.ts       shared types and the Reporter interface
  selfcheck.ts   the whole test suite: node:test asserts over the pure functions
scripts/
  check-jar.mjs  npm run check:jar, the bundled jar's hash and version check
vendor/
  mapepire-server.jar   uploaded to the box and run there
```

## Acknowledgements

This project was written from scratch, but it builds on the work of others:

- **[IBM/ibmi-mcp-server](https://github.com/IBM/ibmi-mcp-server)** (Apache-2.0): a reference for the MCP and mapepire server architecture. No code was copied.
- **[codefori/vscode-ibmi](https://github.com/codefori/vscode-ibmi)** (MIT): a reference for the Db2 for i SQL patterns used to read members, list source, and drive compiles.
- **[mapepire](https://mapepire-ibmi.github.io/)** (Apache-2.0): the Db2 for i SQL engine this server talks over. The [mapepire-server](https://github.com/Mapepire-IBMi/mapepire-server) jar is bundled in `vendor/` and run on the box in single mode, the same way Code for IBM i runs it.

Thanks to those teams and the wider IBM i community.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The dependencies keep their own licenses
(Apache-2.0, MIT, BSD-2-Clause), all of which are compatible with Apache-2.0.
