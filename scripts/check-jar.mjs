// Checks the bundled mapepire jar: that it still matches the hash the code expects, and whether
// upstream has published a newer release. Needs network, so it is not part of `npm run check`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "sshMapepire.ts"), "utf8");
const pick = (name) => src.match(new RegExp(`${name} = "([^"]+)"`))?.[1];

const version = pick("BUNDLED_JAR_VERSION");
const expected = pick("BUNDLED_JAR_SHA256");
if (!version || !expected) {
  console.error("could not find BUNDLED_JAR_VERSION / BUNDLED_JAR_SHA256 in src/sshMapepire.ts");
  process.exit(1);
}

let failed = false;

const actual = createHash("sha256").update(readFileSync(join(root, "vendor", "mapepire-server.jar"))).digest("hex");
if (actual === expected) {
  console.log(`hash    ok       ${version} matches BUNDLED_JAR_SHA256`);
} else {
  console.log(`hash    MISMATCH vendor jar is ${actual}, code expects ${expected}`);
  console.log(`                 the jar was replaced without updating BUNDLED_JAR_SHA256, nothing will connect`);
  failed = true;
}

// npm-style compare, so 2.3.10 sorts above 2.3.9
const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

try {
  const res = await fetch("https://api.github.com/repos/Mapepire-IBMi/mapepire-server/releases/latest", {
    headers: { accept: "application/vnd.github+json", "user-agent": "ibm-i-source-mcp" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`github returned ${res.status}`);
  const latest = (await res.json()).tag_name?.replace(/^v/, "");
  const diff = cmp(latest, version);
  if (diff > 0) {
    console.log(`upstream OUTDATED bundled ${version}, latest is ${latest}`);
    console.log(`                 https://github.com/Mapepire-IBMi/mapepire-server/releases/tag/v${latest}`);
    console.log(`                 to bump: replace vendor/mapepire-server.jar, set BUNDLED_JAR_VERSION and`);
    console.log(`                 BUNDLED_JAR_SHA256 in src/sshMapepire.ts, then retest the connect path on a box`);
    failed = true;
  } else if (diff < 0) {
    console.log(`upstream ahead    bundled ${version} is newer than the latest release ${latest}`);
  } else {
    console.log(`upstream ok       ${version} is the latest release`);
  }
} catch (e) {
  console.log(`upstream skipped  could not reach github (${e.message}), hash check above still stands`);
}

process.exit(failed ? 1 : 0);
