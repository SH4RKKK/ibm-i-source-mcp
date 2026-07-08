import mapepire from "@ibm/mapepire-js";
import type { CompileError, CompileOpts, CompileResult, LibraryListAction, LibraryListChange, LibraryListEntry, MemberMeta, MemberRef, Profile, SearchMatch, SearchOpts, SearchResult, SourceBackend } from "./types.js";
import { assertCompileCommandAllowed, buildCompileCommand, buildLibraryListCommands, parseEvfevent } from "./compile.js";
import { textContains } from "./util.js";
import { closeSshMapepire, connectSshMapepire } from "./sshMapepire.js";

const { SQLJob } = mapepire;

// IBM i object/member name: letter or national first, up to 10 chars.
// This is the trust boundary for values we splice into CL/SQL, so it stays strict.
const NAME = /^[A-Za-z#$@][A-Za-z0-9#$@_.]{0,9}$/;
function validName(v: string, what: string): string {
  if (!NAME.test(v)) throw new Error(`invalid ${what}: "${v}"`);
  return v.toUpperCase();
}
function validLibOrStar(v: string, what: string): string {
  if (/^\*[a-z]+$/i.test(v)) return v.toUpperCase(); // *curlib, *libl
  return validName(v, what);
}

type Row = Record<string, any>;
const randOver = () => "O" + Math.random().toString(36).slice(2, 11).toUpperCase();

// Single block fetch, no paging. Far past any real member or list, so hitting
// it means something is off and we error rather than truncate.
const MAX_ROWS = 100_000;

export class MapepireBackend implements SourceBackend {
  readonly transport = "mapepire" as const;
  private job?: InstanceType<typeof SQLJob>;
  private chain: Promise<unknown> = Promise.resolve();
  private splfTag?: string;      // USRDTA tag stamped on the job's spooled files
  private spoolReady = false;

  constructor(private profile: Profile) {}

  // One serialized job: ovrdbf is job scoped, so its select and dltovr must run
  // on the same job uninterleaved. Add a pool only if it ever matters.
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  // SSH in and run the jar in --single mode (see sshMapepire.ts). The SQLJob and
  // its query engine are unchanged, only the socket under it is an SSH stream.
  private async connect(): Promise<InstanceType<typeof SQLJob>> {
    if (this.job) return this.job;
    this.job = await connectSshMapepire(this.profile);
    return this.job;
  }

  private async sql(statement: string, parameters?: any[]): Promise<Row[]> {
    const job = await this.connect();
    const q = (job as any).query(statement, parameters ? { parameters } : undefined);
    const rs = await q.execute(MAX_ROWS);
    await q.close?.();
    // No paging: if the server says it is not done, there were more than MAX_ROWS
    // rows. Fail loudly rather than hand back a truncated member or member list.
    if (rs.has_results && rs.is_done === false) {
      throw new Error(`result exceeded ${MAX_ROWS} rows and would be truncated, narrow the request`);
    }
    return rs.has_results ? (rs.data as Row[]) : [];
  }

  private async cl(command: string): Promise<void> {
    await this.clResult(command);
  }

  // Like cl() but returns the mapepire CLCommandResult ({success, sql_state, error, joblog}).
  private async clResult(command: string): Promise<any> {
    const job = await this.connect();
    const q = (job as any).query(command, { isClCommand: true });
    const rs = await q.execute();
    await q.close?.();
    return rs;
  }

  async readMember(ref: MemberRef): Promise<{ content: string; meta: MemberMeta }> {
    const lib = validName(ref.library, "library");
    const srcf = validName(ref.sourceFile, "sourceFile");
    const mbr = validName(ref.member, "member");
    return this.serialize(async () => {
      const over = randOver();
      await this.cl(`ovrdbf file(${over}) tofile(${lib}/${srcf}) mbr(${mbr}) ovrscope(*job)`);
      try {
        const col = (await this.sql(
          `select ccsid, length from qsys2.syscolumns where table_schema='${lib}' and table_name='${srcf}' and column_name='SRCDTA'`,
        ))[0];
        const ccsid = Number(col?.CCSID ?? this.profile.sourceFileCcsid);
        const len = Number(col?.LENGTH ?? 80);
        // ccsid 65535 means no conversion, so cast to sourceFileCcsid (default 37).
        const srcdta = ccsid === 65535 ? `cast(srcdta as varchar(${len}) ccsid ${this.profile.sourceFileCcsid}) as srcdta` : "srcdta";
        const rows = await this.sql(`select ${srcdta} from ${over}`);
        const content = rows.map((r) => r.SRCDTA ?? "").join("\n");
        const info = await this.memberInfo(lib, srcf, mbr);
        return {
          content,
          meta: { type: info.type, ccsid, recordLength: len, lineCount: rows.length, lastChanged: info.changed },
        };
      } finally {
        await this.cl(`dltovr file(${over}) lvl(*job)`).catch(() => {});
      }
    });
  }

  // Best-effort metadata; a hiccup here must not fail the source read.
  private async memberInfo(lib: string, srcf: string, mbr: string): Promise<{ type: string; changed?: string }> {
    try {
      const r = (await this.sql(
        `select rtrim(source_type) as source_type,
                varchar_format(last_source_update_timestamp,'YYYY-MM-DD HH24:MI:SS') as changed
         from qsys2.syspartitionstat
         where table_schema='${lib}' and table_name='${srcf}' and system_table_member='${mbr}'`,
      ))[0];
      return { type: (r?.SOURCE_TYPE || "txt").toLowerCase(), changed: r?.CHANGED };
    } catch {
      return { type: "txt" };
    }
  }

  // Source members via object_statistics + a lateral partition_statistics call,
  // like Code for IBM i's getMemberList. source_type not null keeps it to real
  // source members (data PF rows have no SRCDTA to scan).
  private async enumerateMembers(lib: string, srcf?: string, type?: string): Promise<Row[]> {
    const objName = srcf ?? "*ALL";
    return this.sql(
      `select rtrim(o.objname) as source_file, rtrim(p.system_table_member) as name,
              coalesce(rtrim(cast(p.source_type as varchar(10))), '') as type,
              coalesce(rtrim(varchar(p.text)), '') as text,
              p.number_rows as lines
       from table(qsys2.object_statistics('${lib}', '*FILE', '${objName}')) o,
            lateral (select * from table(qsys2.partition_statistics(rpad(o.objlib, 10), rpad(o.objname, 10)))) p
       where trim(p.system_table_member) <> '' and p.source_type is not null
       ${type ? `and rtrim(cast(p.source_type as varchar(10))) = '${type}'` : ""}
       order by source_file, name`,
    );
  }

  // List libraries via object_statistics. The scope value *ALLUSR returns user
  // libraries (where source lives), *ALL adds the IBM Q* system libraries. An
  // optional filter narrows by a substring of the name or description, so an
  // agent can home in on where source lives without dumping the whole system.
  async listLibraries(filter?: string, includeSystem = false): Promise<{ name: string; text: string }[]> {
    const scope = includeSystem ? "*ALL" : "*ALLUSR";
    const f = filter?.trim();
    const like = f ? f.replace(/'/g, "''").toUpperCase() : undefined; // for the LIKE literal
    const where = like ? `where upper(objname) like '%${like}%' or upper(objtext) like '%${like}%'` : "";
    const rows = await this.sql(
      `select rtrim(objname) as name, coalesce(rtrim(objtext), '') as text
       from table(qsys2.object_statistics('${scope}', '*LIB')) ${where}
       order by name`,
    );
    return rows.map((r) => ({ name: r.NAME, text: r.TEXT }));
  }

  // The connection's library list (SYSTEM / PRODUCT / CURRENT / USER portions),
  // in search order. Read-only, so no serialize needed.
  async readLibraryList(): Promise<LibraryListEntry[]> {
    const rows = await this.sql(
      `select type, rtrim(system_schema_name) as lib from qsys2.library_list_info order by ordinal_position`,
    );
    return rows.map((r) => ({ portion: String(r.TYPE), library: r.LIB }));
  }

  // Change the job's library list for this session: addlible / rmvlible /
  // chgcurlib / chglibl. Session scoped and non-destructive (it never touches
  // objects), but it does affect later compiles, so it runs on the serialized job.
  // Names go through validName first, the trust boundary. Returns the new list.
  async changeLibraryList(action: LibraryListAction, change: LibraryListChange): Promise<LibraryListEntry[]> {
    const args: LibraryListChange = { position: change.position };
    if (action === "add" || action === "remove" || action === "set_current") {
      if (!change.library) throw new Error(`library-list action "${action}" needs a library`);
      args.library = validName(change.library, "library");
    } else {
      args.libraries = (change.libraries ?? []).map((l) => validName(l, "library"));
      if (change.currentLibrary) args.currentLibrary = validName(change.currentLibrary, "currentLibrary");
    }
    const cmds = buildLibraryListCommands(action, args);
    return this.serialize(async () => {
      for (const c of cmds) {
        const r = await this.clResult(c);
        if (r?.success === false) throw new Error(`${c} failed: ${r.error || r.sql_state || "unknown error"}`);
      }
      return this.readLibraryList();
    });
  }

  async listSourceFiles(library: string): Promise<{ name: string; text: string }[]> {
    const lib = validName(library, "library");
    const rows = await this.sql(
      `select rtrim(system_table_name) as name, coalesce(rtrim(table_text), '') as text
       from qsys2.systables where table_schema='${lib}' and file_type='S' order by name`,
    );
    return rows.map((r) => ({ name: r.NAME, text: r.TEXT }));
  }

  async listMembers(library: string, sourceFile?: string, memberType?: string) {
    const lib = validName(library, "library");
    const srcf = sourceFile ? validName(sourceFile, "sourceFile") : undefined;
    const type = memberType ? validName(memberType, "memberType") : undefined;
    const rows = await this.serialize(() => this.enumerateMembers(lib, srcf, type));
    return rows.map((r) => ({ sourceFile: r.SOURCE_FILE, name: r.NAME, type: (r.TYPE || "").toLowerCase(), text: r.TEXT || "", lines: Number(r.LINES) || undefined }));
  }

  // Discovery search: a member surfaces if the term is in its name, its text
  // description, or its code, so a purpose word can match even when it never
  // appears in the source itself.
  async searchSource(opts: SearchOpts): Promise<SearchResult> {
    const lib = validName(opts.library, "library");
    const srcf = opts.sourceFile ? validName(opts.sourceFile, "sourceFile") : undefined;
    const type = opts.memberType ? validName(opts.memberType, "memberType") : undefined;
    const max = opts.maxResults ?? 200;
    const cs = !!opts.caseSensitive;
    const raw = opts.searchTerm;
    const needle = (cs ? raw : raw.toUpperCase()).replace(/'/g, "''"); // for the LIKE literal
    const cmp = cs ? "srcdta" : "upper(srcdta)";

    return this.serialize(async () => {
      const members = await this.enumerateMembers(lib, srcf, type);
      const matches: SearchMatch[] = [];
      let truncated = false;
      const add = (m: SearchMatch) => { if (matches.length >= max) { truncated = true; return false; } matches.push(m); return true; };

      outer: for (const m of members) {
        const file = m.SOURCE_FILE, name = m.NAME, mtype = (m.TYPE || "").toLowerCase(), text = m.TEXT || "";
        if (textContains(name, raw, cs) && !add({ library: lib, sourceFile: file, member: name, type: mtype, text, matchedOn: "name" })) break;
        if (textContains(text, raw, cs) && !add({ library: lib, sourceFile: file, member: name, type: mtype, text, matchedOn: "text" })) break;
        // content scan (source members only, so SRCDTA exists)
        const over = randOver();
        await this.cl(`ovrdbf file(${over}) tofile(${lib}/${file}) mbr(${name}) ovrscope(*job)`);
        try {
          const hits = await this.sql(`select srcseq, srcdta from ${over} where ${cmp} like '%${needle}%'`);
          for (const h of hits) {
            if (!add({ library: lib, sourceFile: file, member: name, type: mtype, text, matchedOn: "code", seqNbr: Number(h.SRCSEQ), line: String(h.SRCDTA ?? "").trimEnd() })) break outer;
          }
        } finally {
          await this.cl(`dltovr file(${over}) lvl(*job)`).catch(() => {});
        }
      }
      return { matches, truncated };
    });
  }

  // Write local text back into the member: clrpfm + chunked insert through the
  // same ovrdbf alias the read path uses. No SFTP needed.
  async writeMember(ref: MemberRef, content: string): Promise<{ warnings: string[] }> {
    if (this.profile.readOnly) throw new Error("read-only mode (IBMI_READ_ONLY): upload is disabled");
    const lib = validName(ref.library, "library");
    const srcf = validName(ref.sourceFile, "sourceFile");
    const mbr = validName(ref.member, "member");
    return this.serialize(async () => {
      const col = (await this.sql(
        `select length from qsys2.syscolumns where table_schema='${lib}' and table_name='${srcf}' and column_name='SRCDTA'`,
      ))[0];
      const len = Number(col?.LENGTH ?? 80);
      const raw = content.replace(/\r\n/g, "\n").split("\n");
      if (raw.length && raw[raw.length - 1] === "") raw.pop(); // trailing newline
      const warnings: string[] = [];
      const lines = raw.map((l, i) => {
        if (l.length > len) { warnings.push(`line ${i + 1} truncated to ${len} chars`); return l.slice(0, len); }
        return l;
      });
      const scale = lines.length >= 10000; // SRCSEQ is packed(6,2), max 9999.99
      const over = randOver();
      await this.cl(`ovrdbf file(${over}) tofile(${lib}/${srcf}) mbr(${mbr}) ovrscope(*job)`);
      try {
        await this.cl(`clrpfm file(${lib}/${srcf}) mbr(${mbr})`);
        const CHUNK = 500; // keep each insert well under the ~400KB statement limit
        for (let i = 0; i < lines.length; i += CHUNK) {
          const vals = lines.slice(i, i + CHUNK).map((l, j) => {
            const n = i + j + 1;
            const seq = scale ? (n / 100).toFixed(2) : String(n);
            return `(${seq}, 0, '${l.replace(/'/g, "''")}')`;
          }).join(",");
          await this.sql(`insert into ${over} (srcseq, srcdat, srcdta) values ${vals}`);
        }
        return { warnings };
      } finally {
        await this.cl(`dltovr file(${over}) lvl(*job)`).catch(() => {});
      }
    });
  }

  // Stamp the job's printer output once so we can find compile spool later.
  private async ensureSpoolTag(): Promise<void> {
    if (this.spoolReady) return;
    this.splfTag = "MCP" + Math.random().toString(36).slice(2, 9).toUpperCase();
    await this.cl(`ovrprtf file(*prtf) spool(*yes) hold(*yes) usrdta('${this.splfTag}') splfown(*curusrprf) ovrscope(*job)`);
    this.spoolReady = true;
  }

  private async readEvents(lib: string, obj: string): Promise<CompileError[]> {
    const over = randOver();
    await this.cl(`ovrdbf file(${over}) tofile(${lib}/EVFEVENT) mbr(${obj}) ovrscope(*job)`);
    try {
      const rows = await this.sql(`select cast(evfevent as varchar(400) ccsid ${this.profile.sourceFileCcsid}) as evfevent from ${over}`);
      return parseEvfevent(rows.map((r) => String(r.EVFEVENT ?? "")));
    } finally {
      await this.cl(`dltovr file(${over}) lvl(*job)`).catch(() => {});
    }
  }

  async compile(opts: CompileOpts): Promise<CompileResult> {
    if (this.profile.readOnly) throw new Error("read-only mode (IBMI_READ_ONLY): compile is disabled");
    const srclib = validName(opts.library, "library");
    const srcf = validName(opts.sourceFile, "sourceFile");
    const mbr = validName(opts.member, "member");
    const tgtlib = opts.targetLibrary ? validLibOrStar(opts.targetLibrary, "targetLibrary") : "*CURLIB";
    const name = opts.objectName ? validName(opts.objectName, "objectName") : mbr;
    const type = opts.type ?? (await this.memberInfo(srclib, srcf, mbr)).type;
    const command = buildCompileCommand(type, { tgtlib, name, srclib, srcfile: srcf, mbr }, opts.command);
    // Guard the command (especially a user-supplied override) before it runs as CL.
    assertCompileCommandAllowed(command, this.profile.blockedCl);

    return this.serialize(async () => {
      await this.ensureSpoolTag();
      const startRow = (await this.sql(`values current timestamp`))[0];
      const startTs = startRow ? String(Object.values(startRow)[0]) : undefined;

      const result = await this.clResult(command);
      const success = result?.success !== false;

      let listing = "";
      try {
        const splfs = await this.sql(
          `select qualified_job_name, spooled_file_name, spooled_file_number
             from table(qsys2.spooled_file_info(starting_timestamp => '${startTs}', user_data => '${this.splfTag}', status => '*HELD'))`,
        );
        const parts: string[] = [];
        for (const s of splfs) {
          const rows = await this.sql(
            `select spooled_data from table(systools.spooled_file_data(
                job_name => '${s.QUALIFIED_JOB_NAME}', spooled_file_name => '${s.SPOOLED_FILE_NAME}',
                spooled_file_number => '${s.SPOOLED_FILE_NUMBER}')) order by ordinal_position`,
          );
          parts.push(rows.map((r) => String(r.SPOOLED_DATA ?? "").replace(/\s+$/, "")).join("\n"));
        }
        listing = parts.join("\n");
      } catch (e: any) {
        listing = `(could not read spool: ${e.message})`;
      }

      // Structured errors need a concrete target library to locate EVFEVENT.
      let errors: CompileError[] = [];
      if (tgtlib !== "*CURLIB") errors = await this.readEvents(tgtlib, name).catch(() => []);
      else listing += "\n\n(pass an explicit targetLibrary for structured EVFEVENT errors)";

      await this.cl(`dltsplf file(*select) select(*current *all *all ${this.splfTag})`).catch(() => {});
      const messages = result?.error ? `[${result.sql_state ?? ""}] ${result.error}` : "";
      return { command, success, listing, messages, errors };
    });
  }

  async close(): Promise<void> {
    await closeSshMapepire(this.job);
    this.job = undefined;
    this.spoolReady = false;
  }
}
