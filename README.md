# ibm-i-source-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI tools like Claude Code work directly
with the source members on an IBM i, the RPG, SQLRPGLE, CLLE, and DDS that live on the box. You can
find code by describing what it does, read it as clean UTF-8, edit it locally, then send it back and
compile it, all from your MCP client.

Working with IBM i source used to mean green screen tools and searching through members by hand. The
Code for IBM i extension for Visual Studio Code made that far easier, and it is now how many people
browse and edit. AI assistants have become a normal part of writing code too, but they usually only
see the copy of the source that a team has exported to a Git repository. Plenty of source still lives
on the box, and that copy is the one that actually compiles and runs. This server connects an AI
assistant to that source directly, instead of to a mirror kept in version control.

Reading a member used to also mean pulling down raw EBCDIC and running a conversion script before you
could read it at all. Here the source comes back as normal Unicode text, with the CCSID conversion
handled for you.

It reaches Db2 for i through [mapepire](https://mapepire-ibmi.github.io/), the same SQL engine Code for
IBM i uses. It connects the same way Code for IBM i does too: it opens an SSH session, uploads the
bundled mapepire server, and runs it in single mode over that session. There is no daemon to install on
the IBM i and no extra port to open. If you can SSH to the box, this works. The client is pure Node, so
there is nothing to build on Windows either.

## Requirements

- Node 18 or newer on the client.
- SSH access to the IBM i (port 22, already on by default) and a Java runtime on the box (already there
  on any system running Db2). Nothing else to install on the IBM i.
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
| `IBMI_SSH_PORT` | no | `22` | SSH port on the IBM i |
| `IBMI_NAMING` | no | `system` | SQL naming, `system` or `sql` |
| `IBMI_SOURCE_FILE_CCSID` | no | `37` | EBCDIC page used for CCSID 65535 source columns |
| `IBMI_LOCAL_DIR` | no | `ibmi-src` | where local copies are written |
| `IBMI_MAPEPIRE_JAR` | no | | path to a mapepire jar already on the box, instead of the bundled one |
| `IBMI_READ_ONLY` | no | `false` | `true` disables upload and compile (read, search, and list only) |
| `IBMI_HOST_FINGERPRINT` | no | | pin the SSH host key, for example `SHA256:xxxx`, instead of trust on first use |
| `IBMI_BLOCKED_CL` | no | | extra CL verbs to refuse as a compile command, comma separated |

### Multiple servers

To work with more than one IBM i, add one env file per box next to `.env`. The name after `.env.` is
the server name.

```
.env          the default server
.env.PROD     a server named PROD
.env.DEV      a server named DEV
```

Each file holds the same variables as above for that box. Every tool takes an optional `server` option:
leave it out to use `.env`, or set it to a name like `PROD` to use `.env.PROD`. `list_servers` shows
what is configured. Connections are made per server and reused, so you can move between boxes freely.
All `.env` and `.env.*` files are git-ignored, only `.env.example` is committed.

## Tools

### Discover

- **`list_source_files`**: give it a library and it returns the source physical files (like `QRPGLESRC` or `QDDSSRC`) with their text descriptions.
- **`list_members`**: give it a library, and optionally a `sourceFile` or `memberType`, and it lists every member with its name, type, and text description, the way you would browse in PDM or RDi.
- **`search_source`**: give it a library and a `searchTerm`. A member turns up if the term is in its name, its text description, or its code, and each result tells you which. This lets you find a member by its purpose, for example a Dutch word like `afdeling`, even when that word never appears in the source itself.
- **`list_servers`**: lists the IBM i servers you have configured, so you know what to pass to the `server` option below.

### Read

- **`read_source_member`**: give it a library, source file, and member. It returns the source as clean UTF-8 and saves an editable local copy at `ibmi-src/<lib>/<file>/<member>.<ext>`, where the extension is the member type (a display file becomes `.dspf`, an RPGLE program `.rpgle`, and so on). It also saves an untouched backup under a single backup root that mirrors the tree, `ibmi-src/.backup/<lib>/<file>/<member>.<ext>`, refreshed on every read, so you can always get the original back if an edit goes wrong. It returns metadata too: type, ccsid, line count, and last changed date.

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

- **Connect**: it opens an SSH session to the box, uploads the bundled mapepire server jar to `~/.ibm-i-source-mcp` the first time (and again only if the bundled version changes), and runs it in single mode over that SSH channel. The mapepire SQL protocol then flows over the SSH stream, so there is no daemon and no open port. Queries run over that one connection.
- **Read**: it runs `ovrdbf` to point a job-scoped alias at the member, selects `srcdta` (casting to `IBMI_SOURCE_FILE_CCSID` when the column is CCSID 65535), and joins the lines. A single serialized SQL job keeps that job-scoped override from getting tangled up with other calls.
- **Discover**: members and their text come from `qsys2.object_statistics` joined with a lateral `qsys2.partition_statistics` call, and source files come from `qsys2.systables` where `file_type = 'S'`. Search adds a per-member `like` scan of `srcdta` for code hits.
- **Upload**: it runs `clrpfm`, then inserts the SRCSEQ and SRCDTA rows back through the alias in chunks. If a line is longer than the record length, it is truncated and reported rather than dropped silently.
- **Compile**: it runs the `crt` command with `option(*eventf)`, reads the held spool file through `qsys2.spooled_file_info` and `systools.spooled_file_data`, and parses the EVFEVENT file into structured errors with severity, line, message id, and text.

## Security

This server logs into your IBM i over SSH and can read source, write source, and run compile
commands. Treat it like any tool that can act on the box, and lean on these controls.

- **Least privilege first.** The server has exactly the authority of the profile in the env file.
  Give it a profile with only the object authority the work needs, never `QSECOFR`. This is the main
  control. Everything below is defense in depth.
- **Read only mode.** Set `IBMI_READ_ONLY=true` to allow only read, search, and list. Upload and
  compile are refused. Good for a profile or a person who should only look, never change.
- **Compile command guard.** `compile_member` accepts a `command` override that runs as CL. The
  server only allows create (`crt*`) commands there, refuses a built in list of destructive verbs
  (`dltlib`, `clrpfm`, `dltf`, and so on), and you can extend that list with `IBMI_BLOCKED_CL`. The
  connecting profile's authority is still the real limit.
- **SSH host key checking.** The first connection to a host records its key fingerprint in
  `.ibmi-known-hosts.json`, and later connections must match or the server refuses to connect, which
  guards against a man in the middle. Pin the fingerprint explicitly with `IBMI_HOST_FINGERPRINT` to
  skip trust on first use.

  To get the fingerprint, connect once and let the server record it, then look in
  `.ibmi-known-hosts.json`. You will see a line like `"ibmi.example.com:22": "SHA256:abc123..."`. Copy that
  `SHA256:...` value into `IBMI_HOST_FINGERPRINT` and from then on it is enforced, no longer relying on
  the file. If you want to check it out of band first, from a trusted network run
  `ssh-keyscan <host> | ssh-keygen -lf -`, which prints the same `SHA256:...` fingerprint, and compare.
  The compile default blocklist (`dltlib`, `clrpfm`, and so on) is listed in `.env.example`, and the
  guard only allows create commands in the first place.
- **Bundled jar integrity.** The bundled mapepire jar is checked against a known SHA-256 before it is
  ever uploaded or run, so a tampered artifact is refused.
- **Prompt injection.** Source, text descriptions, and compile listings come back into the AI model
  as untrusted text. A member could contain text that tries to steer the assistant into an unwanted
  upload or compile. Read only mode, the compile guard, and a least privilege profile all limit what
  a successful injection could actually do.
- **Secrets.** Credentials live in `.env` and `.env.*`, which are git-ignored. Keep them readable only
  by you. Consider a dedicated profile per environment.

## Notes and limits

- Search makes one SQL round-trip per member, so scope it with a library and source file when you can.
- The EVFEVENT parser is reliable on message id, severity, and text, and best-effort on line numbers.
- `npm run check` builds the project and runs the self-checks (`node:test`).

## Project layout

```
src/
  index.ts       MCP server and tool registration
  config.ts      .env and env-var loader
  mapepire.ts    mapepire backend (read, search, list, write, compile over SQL)
  sshMapepire.ts SSH transport: runs the bundled mapepire jar in single mode
  compile.ts     compile command templates and EVFEVENT parser
  util.ts        type-to-extension map, local-copy writer, text match
  types.ts       shared types and the SourceBackend interface
  selfcheck.ts   asserts for the parse and config logic
vendor/
  mapepire-server.jar   the mapepire server, uploaded and run on the box
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
