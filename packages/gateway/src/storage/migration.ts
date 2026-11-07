import { readFile, stat } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";
import { DEFAULT_MISSION_LEAD_NPC_ID, DEFAULT_MISSION_PARTICIPANT_NPC_IDS } from "@glc/shared";
import {
  applySchemaInTransaction, classifyDatabase, openDatabase, userVersion, verifyTransitionParity,
  SCHEMA_VERSION
} from "./database.js";
import type { Db } from "./database.js";
import { StorageError } from "./errors.js";
import { createVerifiedBackup, renameWithRetry } from "./file-safety.js";
import { parseLegacyMissionFile, sha256Hex, validateLegacyRecords } from "./legacy-json.js";
import type { LegacyMission, RejectedLegacyRecord } from "./legacy-json.js";
import { SqliteMissionRepository } from "./mission-repository.js";

export interface StorageLogger {
  info(message: string): void;
  warn(message: string): void;
}
const silentLogger: StorageLogger = { info() {}, warn() {} };

/** Seams for crash and failure tests. Production code never sets these. */
export interface MigrationHooks {
  /** After the backup is written, before it is verified. */
  afterBackupWritten?: (path: string) => Promise<void> | void;
  /** After the database was classified as new, before the import transaction begins. */
  beforeTransaction?: () => Promise<void> | void;
  /** Inside the import transaction, after verification, immediately before COMMIT. */
  beforeCommit?: (db: Db) => void;
  /** Replaces the rename that archives data/missions.json after a successful import. */
  renameLegacy?: (from: string, to: string) => Promise<void>;
}

export interface InitializeStorageOptions {
  databasePath: string;
  legacyJsonPath: string;
  backupDir: string;
  busyTimeoutMs?: number;
  now?: () => Date;
  log?: StorageLogger;
  hooks?: MigrationHooks;
}

export interface MigrationReport {
  status: "imported" | "initialized-empty" | "already-initialized";
  importedMissions: number;
  rejectedRecords: number;
  backupPath: string | null;
  sourceSha256: string | null;
  archivedTo: string | null;
  warnings: string[];
}

export interface StorageHandle {
  db: Db;
  repository: SqliteMissionRepository;
  report: MigrationReport;
  close(): void;
}

interface MarkerRow {
  version: number; applied_at: string; source_name: string | null; source_sha256: string | null;
  backup_path: string | null; backup_sha256: string | null;
  imported_count: number | null; rejected_count: number | null;
}

interface ImportPlan {
  sourceName: string | null;
  sourceSha256: string | null;
  backupPath: string | null;       // stored relative to the data folder
  backupSha256: string | null;
  missions: LegacyMission[];
  rejected: RejectedLegacyRecord[];
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StorageError("legacy_unreadable",
      "data/missions.json exists but could not be read. It was not changed.", { cause: error });
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/**
 * Opens (and if needed creates) the mission database.
 *
 * First run with an existing data/missions.json:
 *   1. parse and validate (damaged or unknown-version files fail closed; nothing is touched)
 *   2. write a separate backup, fsync it, re-read it, compare SHA-256
 *   3. in ONE write transaction: create schema, seed transitions, import missions with
 *      Hal as lead and John and Kyle as participants, quarantine invalid records, write the
 *      migration marker, verify every imported row, then COMMIT
 *   4. only after COMMIT, archive the JSON file (failure is not fatal and never re-imports)
 * Any failure before COMMIT rolls everything back and leaves data/missions.json untouched.
 */
export async function initializeStorage(options: InitializeStorageOptions): Promise<StorageHandle> {
  const log = options.log ?? silentLogger;
  const warnings: string[] = [];
  const warn = (message: string) => { warnings.push(message); log.warn(message); };
  const now = options.now ?? (() => new Date());
  const hooks = options.hooks ?? {};
  const dataDir = dirname(options.databasePath);

  const db = openOrExplain(options);
  try {
    let report: MigrationReport;
    if (classifyDatabase(db) === "current") {
      report = await inspectExisting(db, options, warnings, warn, hooks);
    } else {
      const legacy = await readIfExists(options.legacyJsonPath);
      const plan = await planFirstRun(legacy, options, dataDir, now, hooks);
      await hooks.beforeTransaction?.();
      const outcome = commitFirstRun(db, plan, now(), hooks);
      if (outcome === "lost-race") {
        // Another process finished initialising while we prepared. The database wins.
        report = await inspectExisting(db, options, warnings, warn, hooks);
      } else {
        const archivedTo = legacy && plan.sourceSha256
          ? await archiveLegacy(options.legacyJsonPath, plan.sourceSha256, hooks, warn) : null;
        report = {
          status: legacy ? "imported" : "initialized-empty",
          importedMissions: plan.missions.length, rejectedRecords: plan.rejected.length,
          backupPath: plan.backupPath, sourceSha256: plan.sourceSha256, archivedTo, warnings
        };
        log.info(legacy
          ? `[storage] imported ${plan.missions.length} mission(s) from missions.json (${plan.rejected.length} invalid record(s) quarantined). Backup: ${plan.backupPath}`
          : "[storage] created a new mission database");
      }
    }
    const repository = new SqliteMissionRepository(db);
    return { db, repository, report, close() { if (db.open) db.close(); } };
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

/** A file that is not a SQLite database, or is corrupt, gets restore guidance instead of a raw driver error. */
function openOrExplain(options: InitializeStorageOptions): Db {
  try {
    const db = openDatabase({ path: options.databasePath, busyTimeoutMs: options.busyTimeoutMs });
    try {
      classifyDatabase(db);   // reads the header; surfaces corruption here
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && (code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT"))) {
      throw new StorageError("damaged_database",
        "The mission database file is damaged. It was not changed. Restore the newest headquarters-*.sqlite from data/backups "
        + "(or the original missions.json backup) and start again.", { cause: error });
    }
    throw error;
  }
}

async function planFirstRun(
  legacy: Buffer | null, options: InitializeStorageOptions, dataDir: string,
  now: () => Date, hooks: MigrationHooks
): Promise<ImportPlan> {
  if (!legacy) {
    return { sourceName: null, sourceSha256: null, backupPath: null, backupSha256: null, missions: [], rejected: [] };
  }
  // 1. Fail closed on anything that is not a recognised v1 shape (no backup clutter, no changes).
  const parsed = parseLegacyMissionFile(legacy);
  const { valid, rejected } = validateLegacyRecords(parsed.records);
  // 2. Verified backup of the exact bytes BEFORE anything is imported.
  const backup = await createVerifiedBackup(legacy, options.backupDir, now(), hooks.afterBackupWritten);
  return {
    sourceName: basename(options.legacyJsonPath),
    sourceSha256: sha256Hex(legacy),
    backupPath: relative(dataDir, backup.path).split(sep).join("/"),   // portable between Windows and Linux
    backupSha256: backup.sha256,
    missions: valid,
    rejected
  };
}

function commitFirstRun(db: Db, plan: ImportPlan, appliedAt: Date, hooks: MigrationHooks): "committed" | "lost-race" {
  return db.transaction((): "committed" | "lost-race" => {
    // Re-check under the write lock: a second gateway may have initialised the file meanwhile.
    if (userVersion(db) !== 0) return "lost-race";
    applySchemaInTransaction(db);

    const insertMission = db.prepare(
      `INSERT INTO missions (id, title, notes, assigned_npc_id, lead_npc_id, status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
    const insertParticipant = db.prepare(
      "INSERT INTO mission_participants (mission_id, npc_id, position) VALUES (?, ?, ?)");
    for (const mission of plan.missions) {
      insertMission.run(mission.id, mission.title, mission.notes, mission.assignedNpcId,
        DEFAULT_MISSION_LEAD_NPC_ID, mission.status, mission.createdAt, mission.updatedAt);
      DEFAULT_MISSION_PARTICIPANT_NPC_IDS.forEach((npcId, position) =>
        insertParticipant.run(mission.id, npcId, position));
    }

    const insertRejected = db.prepare(
      `INSERT OR IGNORE INTO rejected_records
         (content_sha256, source_name, source_position, reason, raw_json, rejected_at)
       VALUES (?, ?, ?, ?, ?, ?)`);
    for (const record of plan.rejected) {
      insertRejected.run(record.contentSha256, plan.sourceName ?? "missions.json", record.position,
        record.reason, record.rawJson, appliedAt.toISOString());
    }

    db.prepare(
      `INSERT INTO schema_migrations
         (version, applied_at, source_name, source_sha256, backup_path, backup_sha256, imported_count, rejected_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(SCHEMA_VERSION, appliedAt.toISOString(), plan.sourceName, plan.sourceSha256,
      plan.backupPath, plan.backupSha256, plan.missions.length, plan.rejected.length);

    verifyImport(db, plan);
    hooks.beforeCommit?.(db);
    return "committed";
  }).immediate();
}

/** Re-reads what was just written and compares it field by field with the validated source. */
function verifyImport(db: Db, plan: ImportPlan): void {
  const expected = plan.missions.map(mission => ({
    id: mission.id, title: mission.title, notes: mission.notes, assigned: mission.assignedNpcId,
    lead: DEFAULT_MISSION_LEAD_NPC_ID, status: mission.status, revision: 1,
    createdAt: mission.createdAt, updatedAt: mission.updatedAt,
    participants: [...DEFAULT_MISSION_PARTICIPANT_NPC_IDS]
  })).sort((a, b) => a.id.localeCompare(b.id));

  const rows = db.prepare("SELECT * FROM missions ORDER BY id").all() as Array<Record<string, unknown>>;
  const participantRows = db.prepare(
    "SELECT mission_id, npc_id FROM mission_participants ORDER BY mission_id, position"
  ).all() as Array<{ mission_id: string; npc_id: string }>;
  const actual = rows.map(row => ({
    id: row.id, title: row.title, notes: row.notes, assigned: row.assigned_npc_id,
    lead: row.lead_npc_id, status: row.status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
    participants: participantRows.filter(p => p.mission_id === row.id).map(p => p.npc_id)
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new StorageError("migration_failed",
      "The imported missions did not match the source file. Nothing was committed and data/missions.json was not changed.");
  }
  const uniqueRejected = new Set(plan.rejected.map(record => record.contentSha256)).size;
  const storedRejected = (db.prepare("SELECT count(*) AS c FROM rejected_records").get() as { c: number }).c;
  if (storedRejected !== uniqueRejected) {
    throw new StorageError("migration_failed", "Quarantined record count did not match. Nothing was committed.");
  }
}

async function inspectExisting(
  db: Db, options: InitializeStorageOptions, warnings: string[],
  warn: (message: string) => void, hooks: MigrationHooks
): Promise<MigrationReport> {
  verifyTransitionParity(db);
  const marker = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(SCHEMA_VERSION) as MarkerRow | undefined;
  if (!marker) {
    throw new StorageError("damaged_database", "The mission database has no migration record. Refusing to modify it.");
  }
  let archivedTo: string | null = null;
  const legacy = await readIfExists(options.legacyJsonPath);
  if (legacy) {
    if (marker.source_sha256 && sha256Hex(legacy) === marker.source_sha256) {
      // Imported earlier, but the archive rename did not complete. Finish it; never re-import.
      archivedTo = await archiveLegacy(options.legacyJsonPath, marker.source_sha256, hooks, warn);
    } else {
      warn("A data/missions.json file exists but this database is already initialised. "
        + "The database is authoritative; the file was not imported and was left untouched.");
    }
  }
  return {
    status: "already-initialized",
    importedMissions: marker.imported_count ?? 0, rejectedRecords: marker.rejected_count ?? 0,
    backupPath: marker.backup_path, sourceSha256: marker.source_sha256, archivedTo, warnings
  };
}

async function archiveLegacy(
  path: string, sha256: string, hooks: MigrationHooks, warn: (message: string) => void
): Promise<string | null> {
  const candidates = [`${path}.migrated`, `${path}.${sha256.slice(0, 12)}.migrated`];
  const target = await (async () => {
    for (const candidate of candidates) if (!(await exists(candidate))) return candidate;
    return null;
  })();
  if (!target) {
    warn("Could not archive data/missions.json because archive names already exist. The import is complete and it will not be re-imported.");
    return null;
  }
  try {
    await renameWithRetry(path, target, hooks.renameLegacy);
    return target;
  } catch (error) {
    warn(`Could not rename data/missions.json after a successful import (${(error as NodeJS.ErrnoException).code ?? "error"}). `
      + "Your missions are safe in the database and the file will not be re-imported.");
    return null;
  }
}
