import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Profile } from "./types.js";

// Load .env from the install root (one level up from dist/config.js), NOT the
// process cwd — so it's found no matter which folder Claude Code launches the
// server from. Inline env vars (e.g. an mcp.json `env` block) still take
// precedence, since dotenv never overrides an already-set variable.
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const bool = (v: string | undefined, dflt: boolean) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(v));

// Whole config lives in .env — no profiles.json. Exported (env passed in) so
// selfcheck can exercise it without touching the real environment.
export function loadProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  const host = env.IBMI_HOST;
  const user = env.IBMI_USER;
  const password = env.IBMI_PASSWORD;
  if (!host || !user || !password) throw new Error("missing IBMI_HOST, IBMI_USER and/or IBMI_PASSWORD in .env");

  return {
    host,
    user,
    password,
    mapepirePort: Number(env.IBMI_MAPEPIRE_PORT || 8076),
    naming: (env.IBMI_NAMING || "system").toLowerCase() === "sql" ? "sql" : "system",
    allowSelfCert: bool(env.IBMI_ALLOW_SELF_CERT, true),
    sourceFileCcsid: Number(env.IBMI_SOURCE_FILE_CCSID || 37),
  };
}
