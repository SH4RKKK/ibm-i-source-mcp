import mapepire from "@ibm/mapepire-js";
import type { CompileError, CompileOpts, CompileResult, LibraryListAction, LibraryListChange, LibraryListEntry, MemberMeta, MemberRef, Profile, Reporter, SearchMatch, SearchOpts, SearchResult } from "./types.js";
import { NOOP_REPORTER } from "./types.js";
import { assertCompileCommandAllowed, buildCompileCommand, buildLibraryListCommands, parseEvfevent } from "./compile.js";
import { likeLiteral, parseFndstrpdm } from "./util.js";
import { closeSshMapepire, connectSshMapepire, raceJobClosed } from "./sshMapepire.js";

const { SQLJob } = mapepire;

// --- constants ---
const NAME = /^[A-Za-z#$@][A-Za-z0-9#$@_.]{0,9}$/; // trust boundary: spliced into SQL and CL, never bound
const MAX_ROWS = 100_000;        // single block fetch, no paging: fail rather than truncate
const SRCSEQ_WHOLE_MAX = 9999;   // srcseq is packed(6,2), so 9999.99 is the ceiling

// shared by every call, which is what serialize() protects. qtemp is private to the job.
const READ_ALIAS = "MCPREAD", WRITE_ALIAS = "MCPWRITE", EVENT_ALIAS = "MCPEVENT";

// --- types ---
type Row = Record<string, any>;
interface MemberMetaRow { ccsid: number; length: number; type: string; changed?: string; exists: boolean }

// --- validators ---
export function validName(v: string, what: string): string {
  if (!NAME.test(v)) throw new Error(`invalid ${what}: "${v}"`);
  return v.toUpperCase();
}
export function validLibOrStar(v: string, what: string): string {
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
  // file_type='S' keeps data files out, not "source_type is not null": a real source member can
  // have a blank type, and filtering on that hid it entirely.
  private async enumerateMembers(lib: string, srcf?: string, type?: string, filter?: string): Promise<Row[]> {
    const like = filter ? likeLiteral(filter) : undefined;
    return this.sql(`select rtrim(system_table_name) as source_file, rtrim(system_table_member) as name,
              coalesce(rtrim(cast(source_type as varchar(10))), '') as type,
              coalesce(rtrim(varchar(partition_text)), '') as text, number_rows as lines
       from qsys2.syspartitionstat
       where table_schema = '${lib}' and trim(system_table_member) <> ''
         and system_table_name in (select system_table_name from qsys2.systables
                                    where table_schema = '${lib}' and file_type = 'S')
       ${srcf ? `and system_table_name = '${srcf}'` : ""}
       ${type ? `and rtrim(cast(source_type as varchar(10))) = '${type}'` : ""}
       ${like ? `and (upper(system_table_member) like '%${like}%' escape '\\' or upper(partition_text) like '%${like}%' escape '\\')` : ""}
       order by source_file, name`);
  }

  async listLibraries(filter?: string, includeSystem = false, reporter: Reporter = NOOP_REPORTER): Promise<{ name: string; text: string }[]> {
    const scope = includeSystem ? "*ALL" : "*ALLUSR"; // *ALLUSR is user libraries, where source lives
    const f = filter?.trim();
    const like = f ? likeLiteral(f) : undefined;
    const where = like ? `where upper(objname) like '%${like}%' escape '\\' or upper(objtext) like '%${like}%' escape '\\'` : "";
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
  // one fndstrpdm per source file instead of an alias and a scan per member, 20ms down to 1.7ms
  async searchSource(opts: SearchOpts, reporter: Reporter = NOOP_REPORTER): Promise<SearchResult> {
    const lib = validName(opts.library, "library");
    const srcf = opts.sourceFile ? validName(opts.sourceFile, "sourceFile") : undefined;
    const type = opts.memberType ? validName(opts.memberType, "memberType") : undefined;
    const max = opts.maxResults ?? 200;
    const cs = !!opts.caseSensitive;
    const raw = opts.searchTerm;

    await this.connect(reporter);
    return this.serialize(async () => {
      reporter.step(`listing members in ${lib}${srcf ? `/${srcf}` : ""}`);
      const members = await this.enumerateMembers(lib, srcf, type);
      // fndstrpdm has no type filter, so the catalog list is what applies memberType
      const files = new Map<string, Map<string, string>>();
      for (const m of members) {
        const f = String(m.SOURCE_FILE);
        if (!files.has(f)) files.set(f, new Map());
        files.get(f)!.set(String(m.NAME), String(m.TYPE || ""));
      }
      reporter.step(`scanning ${members.length} member(s) across ${files.size} source file(s) for "${raw}"`);

      await this.ensureSpoolTag();
      await this.dropTaggedSpool();

      // fndstrpdm always ignores case, so cs filters the superset below and drops the cap with it
      const cap = cs ? "*all" : String(max + 1);
      const order = [...files.keys()];
      // every scan first, then one spool read: the round trips cost more than the scan does
      const scanned: string[] = [];
      for (const [i, f] of order.entries()) {
        reporter.bar(`searching ${lib}/${f}`, i, order.length);
        const r = await this.clResult(
          `fndstrpdm string('${raw.replace(/'/g, "''")}') file(${lib}/${f}) mbr(*all) option(*none) prtrcds(${cap})`);
        if (r?.success === false) reporter.log("warning", `skipped ${lib}/${f}: ${r.error || r.sql_state || "fndstrpdm failed"}`);
        else scanned.push(f); // a failed scan prints nothing, so it must not shift the pairing
      }
      reporter.bar(`reading ${scanned.length} listing(s)`, order.length, order.length);
      let listings: string[][];
      try { listings = await this.readTaggedSpool(); } finally { await this.dropTaggedSpool(); }
      // listings pair to scans by print order, so a count mismatch would parse every later file
      // against the wrong member set. Wrong hits are worse than none.
      if (listings.length !== scanned.length) throw new Error(
        `search printed ${listings.length} listing(s) for ${scanned.length} source file(s), so hits cannot be tied to members. Narrow it with sourceFile.`);

      const matches: SearchMatch[] = [];
      let truncated = false;
      for (const [i, f] of scanned.entries()) {
        const known = files.get(f)!;
        for (const h of parseFndstrpdm(listings[i] ?? [], new Set(known.keys()), raw)) {
          if (cs && !h.line.includes(raw)) continue;
          if (matches.length >= max) { truncated = true; break; }
          matches.push({ library: lib, sourceFile: f, member: h.member, type: (known.get(h.member) || "").toLowerCase(),
            seqNbr: h.seqNbr, line: h.line });
        }
        if (truncated) break;
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
      // one statement with every row bound, so one round trip: 30000 lines (2.3MB) in 1.4s
      reporter.step(`uploading ${lines.length} lines to ${mbr}`);
      try {
        // srcseq is packed(6,2), so past 9999 lines the whole numbers run out and it steps by .01
        await this.sql(`insert into qtemp.${WRITE_ALIAS} (srcseq, srcdat, srcdta) values (?, ?, ?)`,
          lines.map((l, i) => [scale ? (i + 1) / 100 : i + 1, 0, l]));
      } catch (e: any) {
        const state = created ? `${lib}/${srcf}(${mbr}) was created and is empty` : `${lib}/${srcf}(${mbr}) was cleared and may be incomplete`;
        throw new Error(`upload of ${lines.length} lines failed, ${state}, upload again once the problem is fixed: ${e.message}`);
      }
      reporter.log("info", `uploaded ${lines.length} lines to ${lib}/${srcf}(${mbr})${warnings.length ? ` (${warnings.length} truncated line(s))` : ""}`);
      return { warnings, created };
    });
  }

  // --- spool ---
  // job scoped and touches nothing of the user's, so search still runs under IBMI_READ_ONLY
  private async ensureSpoolTag(): Promise<void> {
    if (this.spoolReady) return;
    // kept across a reconnect: the tag is how dropTaggedSpool reaches the held files the dropped
    // job left. A fresh one each time orphans them on the box permanently.
    this.splfTag ??= ("MCP" + Math.random().toString(36).slice(2).toUpperCase() + "0000000").slice(0, 10);
    await this.sql(qcmdexc(`ovrprtf file(*prtf) spool(*yes) hold(*yes) usrdta('${this.splfTag}') splfown(*curusrprf) ovrscope(*job)`));
    this.spoolReady = true;
  }

  private async readTaggedSpool(): Promise<string[][]> {
    const files = await this.sql(`select rtrim(spooled_file_name) as name, spooled_file_number as nbr,
            rtrim(qualified_job_name) as job
       from table(qsys2.spooled_file_info(user_data => '${this.splfTag}', status => '*HELD'))
       order by nbr`);
    const out: string[][] = [];
    for (const f of files) {
      const rows = await this.sql(`select spooled_data from table(systools.spooled_file_data(
            job_name => '${f.JOB}', spooled_file_name => '${f.NAME}', spooled_file_number => '${f.NBR}'))
          order by ordinal_position`);
      out.push(rows.map((r) => String(r.SPOOLED_DATA ?? "")));
    }
    return out;
  }

  // the exception to assertCompileCommandAllowed refusing dlt*: never from input, and
  // select(*current *all *all <tag>) reaches only this user's spool carrying our random tag.
  private async dropTaggedSpool(): Promise<void> {
    if (!this.splfTag) return;
    await this.sql(qcmdexc(`dltsplf file(*select) select(*current *all *all ${this.splfTag})`)).catch(() => {});
  }

  // --- compile ---

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
      await this.dropTaggedSpool(); // a search that failed mid read leaves its listing behind
      reporter.log("info", `compile command: ${command}`);
      reporter.step(`compiling ${mbr} (${command.trim().split(/\s+/)[0]}) on ${this.profile.host}`);
      const result = await this.clResult(command);
      const success = result?.success !== false;
      reporter.step(`compile ${success ? "succeeded" : "failed"}, fetching the compiler listing from spool`);

      let listing = "";
      try {
        listing = (await this.readTaggedSpool()).flat().map((l) => l.replace(/\s+$/, "")).join("\n");
      } catch (e: any) {
        listing = `(could not read spool: ${e.message})`;
      }

      let errors: CompileError[] = [];
      if (tgtlib !== "*CURLIB") { // EVFEVENT needs a concrete library to locate
        reporter.step(`reading structured errors from ${tgtlib}/EVFEVENT(${name})`);
        errors = await this.readEvents(tgtlib, name).catch(() => []);
      } else listing += "\n\n(pass an explicit targetLibrary for structured EVFEVENT errors)";

      await this.dropTaggedSpool();
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
