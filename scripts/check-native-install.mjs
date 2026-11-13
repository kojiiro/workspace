// CI guard: better-sqlite3 must come from its bundled prebuilt binary, never from a local
// node-gyp compile (which would hide a failure that real Windows PCs without build tools hit).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages", "gateway", "package.json"));
const problems = [];

const npmrc = existsSync(join(root, ".npmrc")) ? readFileSync(join(root, ".npmrc"), "utf8") : "";
if (!/^\s*ignore-scripts\s*=\s*true\s*$/m.test(npmrc)) {
  problems.push(".npmrc must set ignore-scripts=true (see the comments in that file).");
}
const packageDir = dirname(require.resolve("better-sqlite3/package.json"));
if (existsSync(join(packageDir, "build"))) {
  problems.push(`${join(packageDir, "build")} exists: better-sqlite3 was compiled locally instead of using its bundled prebuild.`);
}
try {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  const version = db.prepare("select sqlite_version() as v").get().v;
  db.close();
  console.log(`better-sqlite3 loaded from its bundled prebuild (SQLite ${version}, ${process.platform}-${process.arch}).`);
} catch (error) {
  problems.push("better-sqlite3 failed to load: " + error.message);
}
if (problems.length) {
  console.error("Native install check FAILED:\n- " + problems.join("\n- "));
  process.exit(1);
}
