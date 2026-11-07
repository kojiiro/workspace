import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { StorageError } from "./errors.js";
import type { Db } from "./database.js";
import { userVersion } from "./database.js";

/**
 * Writes a consistent, standalone copy of a LIVE database with VACUUM INTO (never by
 * copying the .sqlite file, which would miss data still in the -wal file), then opens the
 * copy read-only and runs an integrity check. A copy that fails verification is deleted.
 */
export function createDatabaseBackup(db: Db, backupDir: string, now: Date = new Date()): string {
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const target = join(backupDir, `headquarters-${stamp}.sqlite`);
  try {
    db.prepare("VACUUM INTO ?").run(target);
    const copy = new Database(target, { readonly: true, fileMustExist: true });
    try {
      const integrity = copy.pragma("integrity_check", { simple: true });
      const sourceCount = (db.prepare("SELECT count(*) AS c FROM missions").get() as { c: number }).c;
      const copyCount = (copy.prepare("SELECT count(*) AS c FROM missions").get() as { c: number }).c;
      if (integrity !== "ok" || Number(copy.pragma("user_version", { simple: true })) !== userVersion(db) || copyCount < sourceCount) {
        throw new StorageError("backup_failed", "The database backup failed verification and was removed.");
      }
    } finally {
      copy.close();
    }
    return target;
  } catch (error) {
    rmSync(target, { force: true });
    if (error instanceof StorageError) throw error;
    throw new StorageError("backup_failed", "Could not create a database backup.", { cause: error });
  }
}
