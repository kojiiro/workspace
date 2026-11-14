// Usage (after "npm run build"):  npm run db:backup
// Writes a verified, consistent copy of the live mission database into data/backups.
// Safe to run while the gateway is running: it uses VACUUM INTO, never a file copy.
import { existsSync } from "node:fs";
import { createDatabaseBackup } from "./storage/backup.js";
import { openDatabase, userVersion, SCHEMA_VERSION } from "./storage/database.js";
import { resolveDataPaths } from "./storage/paths.js";

const paths = resolveDataPaths();
if (!existsSync(paths.databasePath)) {
  console.error(`No mission database found at ${paths.databasePath}. Nothing to back up.`);
  process.exit(1);
}
const db = openDatabase({ path: paths.databasePath });
try {
  if (userVersion(db) !== SCHEMA_VERSION) throw new Error("This is not an initialised mission database.");
  console.log("Backup written and verified: " + createDatabaseBackup(db, paths.backupDir));
} catch (error) {
  console.error("Backup failed: " + (error as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
