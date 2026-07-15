import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv, parse } from "dotenv";
import type { Profile } from "./types.js";

// Where env files are looked for, in order. The first match wins, so an explicit
// override beats the per-project folder, which beats the stable per-user home.
//
//   1. IBMI_MCP_CONFIG_DIR  an explicit folder, for anyone who wants to pin it
//   2. process.cwd()        the launch folder, handy when run from a project
//   3. ~/.ibm-i-source-mcp  a stable per-user home, the recommended place when
//                           installed with npx (the install folder below lives
//                           in the npx cache and is wiped on every update)
//   4. install folder       next to dist/, so running from a source checkout
//                           with .env files beside the build still works
const CONFIG_DIRS = [
  process.env.IBMI_MCP_CONFIG_DIR,
  process.cwd(),
  join(homedir(), ".ibm-i-source-mcp"),
  join(dirname(fileURLToPath(import.meta.url)), ".."),
].filter((d): d is string => Boolean(d));

// The default server is .env, loaded into process.env. dotenv never overrides an
// already set variable, so a real env var (or the first file found) wins.
for (const d of CONFIG_DIRS) loadEnv({ path: join(d, ".env") });

// Additional servers live in .env.<name> files (one per box). The filename is
// the server name, so the set of files is the registry. "default" means .env.
export function listServers(): string[] {
  const names = new Set<string>();
  for (const d of CONFIG_DIRS) {
    let files: string[] = [];
    try { files = readdirSync(d); } catch { continue; }
    for (const f of files) {
      if (f === ".env") names.add("default");
      else if (f.startsWith(".env.") && f !== ".env.example") names.add(f.slice(5));
    }
  }
  return [...names].sort();
}

// Build a Profile for a named server (.env.<name>), or the default (.env /
// process.env) when no name is given. Exported with env passed in so selfcheck
// can exercise it without touching the real environment.
export function loadProfileFor(server?: string): Profile {
  if (!server || server.toLowerCase() === "default") return loadProfile();
  for (const d of CONFIG_DIRS) {
    const p = join(d, `.env.${server}`);
    if (existsSync(p)) return loadProfile(parse(readFileSync(p)));
  }
  const avail = listServers();
  throw new Error(`no config for server "${server}" (expected a .env.${server} file). Available servers: ${avail.join(", ") || "none"}`);
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));
const list = (v: string | undefined) => (v ? v.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : []);

export function loadProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  const host = env.IBMI_HOST;
  const user = env.IBMI_USER;
  const password = env.IBMI_PASSWORD;
  if (!host || !user || !password) throw new Error("missing IBMI_HOST, IBMI_USER and/or IBMI_PASSWORD in the env file");

  return {
    host,
    user,
    password,
    sshPort: Number(env.IBMI_SSH_PORT || 22),
    naming: (env.IBMI_NAMING || "system").toLowerCase() === "sql" ? "sql" : "system",
    sourceFileCcsid: Number(env.IBMI_SOURCE_FILE_CCSID || 37),
    mapepireJar: env.IBMI_MAPEPIRE_JAR || undefined,
    readOnly: bool(env.IBMI_READ_ONLY, false),
    hostFingerprint: env.IBMI_HOST_FINGERPRINT || undefined,
    blockedCl: list(env.IBMI_BLOCKED_CL),
    connectTimeoutMs: Number(env.IBMI_CONNECT_TIMEOUT_MS || 20000),
  };
}
