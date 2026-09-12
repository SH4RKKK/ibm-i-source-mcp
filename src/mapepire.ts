import mapepire from "@ibm/mapepire-js";
import type { CompileError, CompileOpts, CompileResult, LibraryListAction, LibraryListChange, LibraryListEntry, MemberMeta, MemberRef, Profile, Reporter, SearchMatch, SearchOpts, SearchResult } from "./types.js";
import { NOOP_REPORTER } from "./types.js";
import { assertCompileCommandAllowed, buildCompileCommand, buildLibraryListCommands, parseEvfevent } from "./compile.js";
import { likeLiteral, nestedLikeNeedle } from "./util.js";
import { closeSshMapepire, connectSshMapepire, raceJobClosed } from "./sshMapepire.js";

const { SQLJob } = mapepire;

// --- constants ---
const NAME = /^[A-Za-z#$@][A-Za-z0-9#$@_.]{0,9}$/; // trust boundary: spliced into SQL and CL, never bound
const MAX_ROWS = 100_000;        // single block fetch, no paging: fail rather than truncate
const SRCSEQ_WHOLE_MAX = 9999;   // srcseq is packed(6,2), so 9999.99 is the ceiling

// shared by every call, which is what serialize() protects. qtemp is private to the job.
const READ_ALIAS = "MCPREAD", WRITE_ALIAS = "MCPWRITE", EVENT_ALIAS = "MCPEVENT", SCAN_ALIAS = "MCPSCAN";

// --- types ---
type Row = Record<string, any>;
interface MemberMetaRow { ccsid: number; length: number; type: string; changed?: string; exists: boolean }

// --- validators ---
function validName(v: string, what: string): string {
  if (!NAME.test(v)) throw new Error(`invalid ${what}: "${v}"`);
  return v.toUpperCase();
}
function validLibOrStar(v: string, what: string): string {
  if (/^\*[a-z]+$/i.test(v)) return v.toUpperCase(); // *curlib, *libl
  return validName(v, what);
}
const refNames = (r: MemberRef) => ({ lib: validName(r.library, "library"), srcf: validName(r.sourceFile, "sourceFile"), mbr: validName(r.member, "member") });

// --- sql templates ---
// an alias is the only way to address one member from SQL
export function aliasStmt(alias: string, lib: string, srcf: string, mbr: string, then?: string): string {
  return `begin
    begin declare continue handler for sqlexception begin end;
      execute immediate 'drop alias qtemp.${alias}'; end;
    execute immediate 'create alias qtemp.${alias} for ${lib}.${srcf}(${mbr})';
    ${then ? `${then};` : ""}
  end`;
}

// left join: a missing member still returns the file's row, which is the exists check
export function memberMetaStmt(lib: string, srcf: string, mbr: string): string {
  return `select c.ccsid, c.length, rtrim(cast(p.source_type as varchar(10))) as source_type,
            varchar_format(p.last_source_update_timestamp,'YYYY-MM-DD HH24:MI:SS') as changed,
            p.system_table_member as found
     from qsys2.syscolumns c
     left join qsys2.syspartitionstat p on p.table_schema = c.table_schema
      and p.table_name = c.table_name and p.system_table_member = '${mbr}'
    where c.table_schema='${lib}' and c.table_name='${srcf}' and c.column_name='SRCDTA'`;
}

// a real `cl` request costs the mapepire server three statements and blocks the connection
export const qcmdexc = (command: string) => `call qsys2.qcmdexc('${command.replace(/'/g, "''")}')`;

export function scanBatchValues(members: { file: string; name: string }[]): string {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return members.map((m) => `(${lit(m.file)},${lit(m.name)})`).join(",");
}

// --- backend ---
export class MapepireBackend {
  private job?: InstanceType<typeof SQLJob>;
  private connecting?: Promise<InstanceType<typeof SQLJob>>;
  private chain: Promise<unknown> = Promise.resolve();
  private splfTag?: string;      // usrdta tag stamped on this job's spooled files
  private spoolReady = false;

  constructor(private profile: Profile) {}

  // --- job plumbing ---
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  private async connect(reporter: Reporter = NOOP_REPORTER): Promise<InstanceType<typeof SQLJob>> {
    if (this.job && (this.job as any).status !== "ended") return this.job;
    if (!this.connecting) {
      if (this.job) {
        reporter.log("notice", `connection to ${this.profile.host} was lost, reconnecting`);
        this.job = undefined;
        this.spoolReady = false; // ovrprtf was job scoped, the new job needs it again
      }
      this.connecting = connectSshMapepire(this.profile, reporter).finally(() => (this.connecting = undefined));
    }
    this.job = await this.connecting;
    return this.job;
  }

  private async sql(statement: string, parameters?: any[]): Promise<Row[]> {
    const job = await this.connect();
    const q = (job as any).query(statement, parameters ? { parameters } : undefined);
    const rs: any = await raceJobClosed(job, q.execute(MAX_ROWS));
    await q.close?.();
    // not done means there were more rows than MAX_ROWS
    if (rs.has_results && rs.is_done === false) throw new Error(`result exceeded ${MAX_ROWS} rows and would be truncated, narrow the request`);
    return rs.has_results ? (rs.data as Row[]) : [];
  }

  private async runOrThrow(statement: string, what: string): Promise<void> {
    try { await this.sql(statement); } catch (e: any) { throw new Error(`${what} failed: ${e?.message || e}`); }
  }

  private async clResult(command: string): Promise<any> {
    const job = await this.connect();
    const q = (job as any).query(command, { isClCommand: true });
    const rs = await raceJobClosed(job, q.execute());
    await q.close?.();
    return rs;
  }

  // --- read ---
  async readMember(ref: MemberRef, reporter: Reporter = NOOP_REPORTER): Promise<{ content: string; meta: MemberMeta }> {
    const { lib, srcf, mbr } = refNames(ref);
    await this.connect(reporter);
    return this.serialize(async () => {
      reporter.step(`reading ${lib}/${srcf}(${mbr})`);
      const [meta] = await Promise.all([this.memberMeta(lib, srcf, mbr, true), this.sql(aliasStmt(READ_ALIAS, lib, srcf, mbr))]);
      // ccsid 65535 means no conversion, so cast to sourceFileCcsid (default 37)
      const srcdta = meta.ccsid === 65535 ? `cast(srcdta as varchar(${meta.length}) ccsid ${this.profile.sourceFileCcsid}) as srcdta` : "srcdta";
      const rows = await this.sql(`select ${srcdta} from qtemp.${READ_ALIAS}`);
      reporter.step(`downloaded ${rows.length} lines from ${lib}/${srcf}(${mbr})`);
      return {
        content: rows.map((r) => r.SRCDTA ?? "").join("\n"),
        meta: { type: meta.type, ccsid: meta.ccsid, lineCount: rows.length, lastChanged: meta.changed },
      };
    });
  }

  // soft: read path only. On upload a thrown query reads as exists:false, and create:true addpfms over a live member.
  private async memberMeta(lib: string, srcf: string, mbr: string, soft = false): Promise<MemberMetaRow> {
    let r: Row | undefined;
    try { r = (await this.sql(memberMetaStmt(lib, srcf, mbr)))[0]; } catch (e) { if (!soft) throw e; }
    return { ccsid: Number(r?.CCSID ?? this.profile.sourceFileCcsid), length: Number(r?.LENGTH ?? 80),
      type: (r?.SOURCE_TYPE || "txt").toLowerCase(), changed: r?.CHANGED ?? undefined, exists: r?.FOUND != null };
  }

  // --- catalog and library list ---
  private async enumerateMembers(lib: string, srcf?: string, type?: string, filter?: string): Promise<Row[]> {
    const like = filter ? likeLiteral(filter) : undefined;
    return this.sql(`select rtrim(system_table_name) as source_file, rtrim(system_table_member) as name,
              coalesce(rtrim(cast(source_type as varchar(10))), '') as type,
              coalesce(rtrim(varchar(partition_text)), '') as text, number_rows as lines
       from qsys2.syspartitionstat
       where table_schema = '${lib}' and source_type is not null and trim(system_table_member) <> ''
       ${srcf ? `and system_table_name = '${srcf}'` : ""}
       ${type ? `and rtrim(cast(source_type as varchar(10))) = '${type}'` : ""}
       ${like ? `and (upper(system_table_member) like '%${like}%' or upper(partition_text) like '%${like}%')` : ""}
       order by source_file, name`);
  }

  async listLibraries(filter?: string, includeSystem = false, reporter: Reporter = NOOP_REPORTER): Promise<{ name: string; text: string }[]> {
    const scope = includeSystem ? "*ALL" : "*ALLUSR"; // *ALLUSR is user libraries, where source lives
    const f = filter?.trim();
    const like = f ? likeLiteral(f) : undefined;
    const where = like ? `where upper(objname) like '%${like}%' or upper(objtext) like '%${like}%'` : "";
    await this.connect(reporter);
    reporter.step(`listing ${includeSystem ? "all" : "user"} libraries${f ? ` matching "${f}"` : ""}, a full scan can take a moment`);
    const rows = await this.sql(`select rtrim(objname) as name, coalesce(rtrim(objtext), '') as text
       from table(qsys2.object_statistics('${scope}', '*LIB')) ${where}
       order by name`);
    return rows.map((r) => ({ name: r.NAME, text: r.TEXT }));
  }

  async readLibraryList(reporter: Reporter = NOOP_REPORTER): Promise<LibraryListEntry[]> {
    await this.connect(reporter);
    reporter.step("reading the library list");
    const rows = await this.sql(`select type, rtrim(system_schema_name) as lib from qsys2.library_list_info order by ordinal_position`);
    return rows.map((r) => ({ portion: String(r.TYPE), library: r.LIB }));
  }

  async changeLibraryList(action: LibraryListAction, change: LibraryListChange, reporter: Reporter = NOOP_REPORTER): Promise<LibraryListEntry[]> {
    if (this.profile.readOnly) throw new Error("read-only mode (IBMI_READ_ONLY): changing the library list is disabled");
    const args: LibraryListChange = { position: change.position };
    if (action === "add" || action === "remove" || action === "set_current") {
      if (!change.library) throw new Error(`library-list action "${action}" needs a library`);
      args.library = validName(change.library, "library");
    } else {
      args.libraries = (change.libraries ?? []).map((l) => validName(l, "library"));
      if (change.currentLibrary) args.currentLibrary = validName(change.currentLibrary, "currentLibrary");
    }
    const cmds = buildLibraryListCommands(action, args);
    await this.connect(reporter);
    return this.serialize(async () => {
      for (const c of cmds) {
        reporter.step(`running ${c}`);
        const r = await this.clResult(c);
        if (r?.success === false) throw new Error(`${c} failed: ${r.error || r.sql_state || "unknown error"}`);
      }
      reporter.log("info", `library list changed (${action}): ${cmds.join("; ")}`);
      reporter.step("reading the updated library list");
      return this.readLibraryList();
    });
  }

  async listSourceFiles(library: string, reporter: Reporter = NOOP_REPORTER): Promise<{ name: string; text: string }[]> {
    const lib = validName(library, "library");
    await this.connect(reporter);
    reporter.step(`listing source files in ${lib}`);
    const rows = await this.sql(`select rtrim(system_table_name) as name, coalesce(rtrim(table_text), '') as text
       from qsys2.systables where table_schema='${lib}' and file_type='S' order by name`);
    return rows.map((r) => ({ name: r.NAME, text: r.TEXT }));
  }

  async listMembers(library: string, sourceFile?: string, memberType?: string, filter?: string, reporter: Reporter = NOOP_REPORTER) {
    const lib = validName(library, "library");
    const srcf = sourceFile ? validName(sourceFile, "sourceFile") : undefined;
    const type = memberType ? validName(memberType, "memberType") : undefined;
    const f = filter?.trim() || undefined;
    await this.connect(reporter);
    reporter.step(`listing members in ${lib}${srcf ? `/${srcf}` : " (all source files)"}${f ? ` matching "${f}"` : ""}`);
    const rows = await this.enumerateMembers(lib, srcf, type, f);
    return rows.map((r) => ({ sourceFile: r.SOURCE_FILE, name: r.NAME, type: (r.TYPE || "").toLowerCase(), text: r.TEXT || "", lines: Number(r.LINES) || undefined }));
  }

  // --- search ---
  async searchSource(opts: SearchOpts, reporter: Reporter = NOOP_REPORTER): Promise<SearchResult> {
    const lib = validName(opts.library, "library");
    const srcf = opts.sourceFile ? validName(opts.sourceFile, "sourceFile") : undefined;
    const type = opts.memberType ? validName(opts.memberType, "memberType") : undefined;
    const max = opts.maxResults ?? 200;
    const cs = !!opts.caseSensitive;
    const raw = opts.searchTerm;
    const cmp = cs ? "srcdta" : "upper(srcdta)";
    const needle = nestedLikeNeedle(raw, cs);
    const BATCH = 250;

    await this.connect(reporter);
    return this.serialize(async () => {
      reporter.step(`listing members in ${lib}${srcf ? `/${srcf}` : ""}`);
      const members = await this.enumerateMembers(lib, srcf, type);
      reporter.step(`scanning ${members.length} member(s) in ${lib}${srcf ? `/${srcf}` : ""} for "${raw}"`);

      await this.sql(`begin
        begin declare continue handler for sqlexception begin end;
          execute immediate 'drop table qtemp.srchits'; end;
        execute immediate 'create table qtemp.srchits (source_file char(10), name char(10), srcseq decimal(6,2), srcdta varchar(1000))';
      end`);

      // ponytail: the continue handler skips a failing member silently (damaged, locked, wrong
      // record format). Write a marker row into srchits if a search ever has to report what it missed.
      let scanned = 0;
      for (let off = 0; off < members.length; off += BATCH) {
        const values = scanBatchValues(members.slice(off, off + BATCH).map((m) => ({ file: String(m.SOURCE_FILE), name: String(m.NAME) })));
        await this.sql(`begin
          declare hits int default 0;
          declare added int default 0;
          declare continue handler for sqlexception begin end;
          for c as (select f as source_file, m as name from (values ${values}) t(f, m)) do
            if hits <= ${max} then
              execute immediate 'drop alias qtemp.${SCAN_ALIAS}';
              execute immediate 'create alias qtemp.${SCAN_ALIAS} for ${lib}.'
                || rtrim(c.source_file) || '(' || rtrim(c.name) || ')';
              execute immediate 'insert into qtemp.srchits
                  select ''' || rtrim(c.source_file) || ''', ''' || rtrim(c.name) || ''',
                         srcseq, cast(srcdta as varchar(1000))
                    from qtemp.${SCAN_ALIAS}
                   where ${cmp} like ''%${needle}%'' escape ''\\''
                   fetch first ${max + 1} rows only';
              get diagnostics added = row_count;
              set hits = hits + added;
            end if;
          end for;
        end`);

        scanned = Math.min(off + BATCH, members.length);
        reporter.bar(`scanned ${scanned} of ${members.length} member(s)`, scanned, members.length);
        if (scanned < members.length) {
          const counted = await this.sql(`select count(*) as n from qtemp.srchits`);
          if (Number(counted[0]?.N ?? 0) > max) break;
        }
      }

      const hits = await this.sql(`select rtrim(source_file) as source_file, rtrim(name) as name, srcseq, srcdta
         from qtemp.srchits order by source_file, name, srcseq
         fetch first ${max + 1} rows only`);

      const meta = new Map(members.map((m) => [`${m.SOURCE_FILE}(${m.NAME})`, m]));
      const matches: SearchMatch[] = [];
      let truncated = false;
      for (const h of hits) {
        if (matches.length >= max) { truncated = true; break; }
        const m = meta.get(`${h.SOURCE_FILE}(${h.NAME})`);
        matches.push({ library: lib, sourceFile: h.SOURCE_FILE, member: h.NAME, type: (m?.TYPE || "").toLowerCase(), seqNbr: Number(h.SRCSEQ), line: String(h.SRCDTA ?? "").trimEnd() });
      }
      reporter.log("info", `search for "${raw}" in ${lib}: ${matches.length} match(es) across ${members.length} member(s)${truncated ? " (truncated at maxResults)" : ""}`);
      return { matches, truncated };
    });
  }

  // --- write ---
  async writeMember(
    ref: MemberRef,
    content: string,
    reporter: Reporter = NOOP_REPORTER,
    opts: { create?: boolean; memberType?: string; text?: string } = {},
  ): Promise<{ warnings: string[]; created: boolean }> {
    if (this.profile.readOnly) throw new Error("read-only mode (IBMI_READ_ONLY): upload is disabled");
    const { lib, srcf, mbr } = refNames(ref);
    await this.connect(reporter);
    return this.serialize(async () => {
      reporter.step(`checking ${lib}/${srcf}(${mbr})`);
      const meta = await this.memberMeta(lib, srcf, mbr); // nothing is touched until this passes
      let created = false;
      if (!meta.exists) {
        if (!opts.create) throw new Error(
          `${lib}/${srcf}(${mbr}) does not exist, so there is nothing to upload into. ` +
          `Nothing was changed on the IBM i. To add it, call upload_source_member again with ` +
          `create: true (that runs addpfm), and pass memberType if it cannot be taken from the ` +
          `local file's extension.`);
        const type = validName((opts.memberType ?? "").trim(), "memberType");
        const desc = (opts.text ?? "").replace(/\s+/g, " ").trim().slice(0, 50).replace(/'/g, "''");
        reporter.step(`creating member ${mbr} with srctype(${type})`);
        await this.runOrThrow(
          qcmdexc(`addpfm file(${lib}/${srcf}) mbr(${mbr}) srctype(${type})${desc ? ` text('${desc}')` : ""}`),
          `creating member ${lib}/${srcf}(${mbr})`,
        );
        reporter.log("info", `created ${lib}/${srcf}(${mbr}) as srctype ${type}`);
        created = true;
      }
      const len = meta.length;
      const raw = content.replace(/\r\n/g, "\n").split("\n");
      if (raw.length && raw[raw.length - 1] === "") raw.pop(); // trailing newline
      const warnings: string[] = [];
      const lines = raw.map((l, i) => {
        if (l.length > len) { warnings.push(`line ${i + 1} truncated to ${len} chars`); return l.slice(0, len); }
        return l;
      });
      if (warnings.length) reporter.log("warning", `${warnings.length} line(s) are longer than the ${len}-char record length and will be truncated`);
      const scale = lines.length > SRCSEQ_WHOLE_MAX;

      reporter.step(created ? `preparing the new member ${mbr}` : `clearing ${mbr} (clrpfm) before the upload`);
      await this.runOrThrow(
        aliasStmt(WRITE_ALIAS, lib, srcf, mbr, created ? undefined : qcmdexc(`clrpfm file(${lib}/${srcf}) mbr(${mbr})`)),
        `preparing ${lib}/${srcf}(${mbr}) for upload (nothing was changed)`,
      );

      reporter.log("info", `${created ? "filling the new" : "replacing the content of"} ${lib}/${srcf}(${mbr}) with ${lines.length} lines`);
      const CHUNK = 1000; // a 2D parameter array becomes one addBatch, so a chunk is one round trip
      let written = 0;
      try {
        for (let i = 0; i < lines.length; i += CHUNK) {
          const rows = lines.slice(i, i + CHUNK).map((l, j) => [scale ? (i + j + 1) / 100 : i + j + 1, 0, l]);
          await this.sql(`insert into qtemp.${WRITE_ALIAS} (srcseq, srcdat, srcdta) values (?, ?, ?)`, rows);
          written = Math.min(i + CHUNK, lines.length);
          reporter.bar(`uploading ${mbr}: ${written}/${lines.length} lines`, written, lines.length);
        }
      } catch (e: any) {
        const state = created ? `${lib}/${srcf}(${mbr}) was created and is empty` : `${lib}/${srcf}(${mbr}) was cleared and is now incomplete`;
        throw new Error(`upload stopped at ${written}/${lines.length} lines, ${state}, upload again once the problem is fixed: ${e.message}`);
      }
      reporter.log("info", `uploaded ${lines.length} lines to ${lib}/${srcf}(${mbr})${warnings.length ? ` (${warnings.length} truncated line(s))` : ""}`);
      return { warnings, created };
    });
  }

  // --- compile ---
  private async ensureSpoolTag(): Promise<void> {
    if (this.spoolReady) return;
    this.splfTag = "MCP" + Math.random().toString(36).slice(2, 9).toUpperCase();
    await this.sql(qcmdexc(`ovrprtf file(*prtf) spool(*yes) hold(*yes) usrdta('${this.splfTag}') splfown(*curusrprf) ovrscope(*job)`));
    this.spoolReady = true;
  }

  private async readEvents(lib: string, obj: string): Promise<CompileError[]> {
    await this.sql(aliasStmt(EVENT_ALIAS, lib, "EVFEVENT", obj));
    const rows = await this.sql(`select cast(evfevent as varchar(400) ccsid ${this.profile.sourceFileCcsid}) as evfevent from qtemp.${EVENT_ALIAS}`);
    return parseEvfevent(rows.map((r) => String(r.EVFEVENT ?? "")));
  }

  async compile(opts: CompileOpts, reporter: Reporter = NOOP_REPORTER): Promise<CompileResult> {
    if (this.profile.readOnly) throw new Error("read-only mode (IBMI_READ_ONLY): compile is disabled");
    const { lib: srclib, srcf, mbr } = refNames(opts);
    const tgtlib = opts.targetLibrary ? validLibOrStar(opts.targetLibrary, "targetLibrary") : "*CURLIB";
    const name = opts.objectName ? validName(opts.objectName, "objectName") : mbr;
    await this.connect(reporter);
    let type = opts.type;
    if (!type) {
      reporter.step(`detecting the member type of ${srclib}/${srcf}(${mbr})`);
      type = (await this.memberMeta(srclib, srcf, mbr)).type;
    }
    const command = buildCompileCommand(type, { tgtlib, name, srclib, srcfile: srcf, mbr }, opts.command);
    assertCompileCommandAllowed(command, this.profile.blockedCl);

    return this.serialize(async () => {
      await this.ensureSpoolTag();
      reporter.log("info", `compile command: ${command}`);
      reporter.step(`compiling ${mbr} (${command.trim().split(/\s+/)[0]}) on ${this.profile.host}`);
      const result = await this.clResult(command);
      const success = result?.success !== false;
      reporter.step(`compile ${success ? "succeeded" : "failed"}, fetching the compiler listing from spool`);

      let listing = "";
      try {
        const splfs = await this.sql(`select qualified_job_name, spooled_file_name, spooled_file_number
             from table(qsys2.spooled_file_info(user_data => '${this.splfTag}', status => '*HELD'))`);
        const parts: string[] = [];
        for (const s of splfs) {
          const rows = await this.sql(`select spooled_data from table(systools.spooled_file_data(
                job_name => '${s.QUALIFIED_JOB_NAME}', spooled_file_name => '${s.SPOOLED_FILE_NAME}',
                spooled_file_number => '${s.SPOOLED_FILE_NUMBER}')) order by ordinal_position`);
          parts.push(rows.map((r) => String(r.SPOOLED_DATA ?? "").replace(/\s+$/, "")).join("\n"));
        }
        listing = parts.join("\n");
      } catch (e: any) {
        listing = `(could not read spool: ${e.message})`;
      }

      let errors: CompileError[] = [];
      if (tgtlib !== "*CURLIB") { // EVFEVENT needs a concrete library to locate
        reporter.step(`reading structured errors from ${tgtlib}/EVFEVENT(${name})`);
        errors = await this.readEvents(tgtlib, name).catch(() => []);
      } else listing += "\n\n(pass an explicit targetLibrary for structured EVFEVENT errors)";

      await this.sql(qcmdexc(`dltsplf file(*select) select(*current *all *all ${this.splfTag})`)).catch(() => {});
      const messages = result?.error ? `[${result.sql_state ?? ""}] ${result.error}` : "";
      reporter.log(success ? "info" : "error", `compile ${mbr}: ${success ? "SUCCESS" : "FAILED"} (${errors.length} evfevent record(s))`);
      return { command, success, listing, messages, errors };
    });
  }

  async close(): Promise<void> {
    await closeSshMapepire(this.job);
    this.job = undefined;
    this.spoolReady = false;
  }
}
