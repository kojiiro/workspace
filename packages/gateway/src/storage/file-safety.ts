import { closeSync, fsyncSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { StorageError } from "./errors.js";
import { sha256Hex } from "./legacy-json.js";

const transientRenameCodes = new Set(["EPERM", "EBUSY", "EACCES"]);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Best effort: flush a directory entry to disk. Windows cannot open directories, so errors are ignored. */
export function fsyncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* not supported on this platform */ }
}

export interface VerifiedBackup {
  path: string;
  sha256: string;
  reused: boolean;
}

function timestampForFileName(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Copies the exact source bytes to a separate file, fsyncs it, then re-reads it and
 * compares SHA-256 digests. Windows-safe file names (no colons). An existing verified
 * backup of identical content is reused so repeated failed attempts do not pile up copies.
 */
export async function createVerifiedBackup(
  source: Buffer,
  backupDir: string,
  now: Date,
  afterWritten?: (path: string) => Promise<void> | void
): Promise<VerifiedBackup> {
  const digest = sha256Hex(source);
  await mkdir(backupDir, { recursive: true });

  const prefix = "missions.v1-";
  const suffix = `-${digest.slice(0, 12)}.json`;
  for (const name of await readdir(backupDir)) {
    if (name.startsWith(prefix) && name.endsWith(suffix)) {
      const existing = join(backupDir, name);
      const bytes = await readFile(existing).catch(() => null);
      if (bytes && sha256Hex(bytes) === digest) return { path: existing, sha256: digest, reused: true };
    }
  }

  const path = join(backupDir, `${prefix}${timestampForFileName(now)}${suffix}`);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(source);
      await handle.sync();
    } finally {
      await handle.close();
    }
    fsyncDirectory(backupDir);
    if (afterWritten) await afterWritten(path);
    const copied = await readFile(path);
    if (sha256Hex(copied) !== digest || copied.length !== source.length) {
      throw new StorageError("backup_failed",
        "The backup copy did not match the original (SHA-256 mismatch). Nothing was imported and data/missions.json was not changed.");
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    if (error instanceof StorageError) throw error;
    throw new StorageError("backup_failed",
      "Could not write a verified backup of data/missions.json. Nothing was imported and the file was not changed.",
      { cause: error });
  }
  return { path, sha256: digest, reused: false };
}

export async function renameWithRetry(
  from: string,
  to: string,
  rename_: (from: string, to: string) => Promise<void> = rename
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename_(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !transientRenameCodes.has(code) || attempt >= 3) throw error;
      await delay(80 * (attempt + 1));
    }
  }
}
