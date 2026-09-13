import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv, parse } from "dotenv";
import type { Profile } from "./types.js";

// --- constants ---
// searched in order, first match wins. The install folder is last because an npx install lives
// in a cache that is wiped on every update.
const CONFIG_DIRS = [
  process.env.IBMI_MCP_CONFIG_DIR,
  join(homedir(), ".ibm-i-source-mcp"),
  join(dirname(fileURLToPath(import.meta.url)), ".."),
].filter((d): d is string => Boolean(d));

// dotenv never overrides an already set variable, so a real env var (or the first file found) wins
for (const d of CONFIG_DIRS) loadEnv({ path: join(d, ".env") });

// --- servers ---
// the filename is the server name, so the set of .env.<name> files is the registry
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

export function loadProfileFor(server?: string): Profile {
  if (!server || server.toLowerCase() === "default") return loadProfile();
  for (const d of CONFIG_DIRS) {
    const p = join(d, `.env.${server}`);
    if (existsSync(p)) return loadProfile(parse(readFileSync(p)));
  }
  throw new Error(`no config for server "${server}" (expected a .env.${server} file). Available servers: ${listServers().join(", ") || "none"}`);
}

// --- profile ---
// fails closed: IBMI_READ_ONLY is a safety flag, so anything set that is not an explicit off
// counts as on. "true " and "y" used to read as false and quietly unlock upload and compile.
const bool = (v: string | undefined, dflt: boolean) => {
  const t = v?.trim().toLowerCase();
  return !t ? dflt : !/^(0|false|no|off)$/.test(t);
};
const list = (v: string | undefined) => (v ? v.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : []);

export function loadProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  const { IBMI_HOST: host, IBMI_USER: user, IBMI_PASSWORD: password } = env;
  if (!host || !user || !password) throw new Error("missing IBMI_HOST, IBMI_USER and/or IBMI_PASSWORD in the env file");
  return {
    host, user, password,
    sshPort: Number(env.IBMI_SSH_PORT || 22),
    sourceFileCcsid: Number(env.IBMI_SOURCE_FILE_CCSID || 37),
    mapepireJar: env.IBMI_MAPEPIRE_JAR || undefined,
    readOnly: bool(env.IBMI_READ_ONLY, false),
    blockedCl: list(env.IBMI_BLOCKED_CL),
  };
}
