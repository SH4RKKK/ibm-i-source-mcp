import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Profile } from "./types.js";

// Config lives in a .env file. Look for it in the folder the server is launched
// from, then in the server's own install folder as a fallback. dotenv never
// overrides an already-set variable, so a real environment variable (or the
// first file found) wins. This keeps all config in a .env for every install
// method, whether run from source or via npx with a chosen working directory.
loadEnv({ path: join(process.cwd(), ".env") });
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
