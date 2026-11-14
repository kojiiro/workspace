import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TEAM_RUN_TRANSITIONS } from "@glc/shared";
import { StorageError } from "./errors.js";
import { SCHEMA_V2_SQL } from "./schema.generated.js";

export type Db = Database.Database;
export const SCHEMA_VERSION = 2;
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenDatabaseOptions {
  path: string;                  // a file path, or ":memory:" for tests
  busyTimeoutMs?: number;
}

/**
 * Opens a connection and applies the per-connection safety settings the contract
 * requires. Every setting is read back, so a build that silently ignores one
 * (for example a different SQLite driver) fails at startup, not in production.
 */
export function openDatabase(options: OpenDatabaseOptions): Db {
  const inMemory = options.path === ":memory:";
  if (!inMemory) mkdirSync(dirname(options.path), { recursive: true });
  const db = new Database(options.path);
  try {
    db.pragma("busy_timeout = " + Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)));
    if (!inMemory) db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("recursive_triggers = ON");
    db.pragma("synchronous = FULL");
    assertConnectionSafety(db, !inMemory);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function assertConnectionSafety(db: Db, expectWal: boolean): void {
  const expectations: Array<[string, unknown]> = [
    ["foreign_keys", 1],
    ["recursive_triggers", 1],
    ["synchronous", 2]            // 2 = FULL
  ];
  if (expectWal) expectations.push(["journal_mode", "wal"]);
  for (const [name, expected] of expectations) {
    const actual = db.pragma(name, { simple: true });
    if (actual !== expected) {
      throw new StorageError("unsafe_connection",
        `SQLite setting ${name} is ${String(actual)}, expected ${String(expected)}. Refusing to open the mission database.`);
    }
  }
}

export function userVersion(db: Db): number {
  return Number(db.pragma("user_version", { simple: true }));
}

function userTableCount(db: Db): number {
  return (db.prepare(
    "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).get() as { c: number }).c;
}

/** Throws unless the file is empty (new) or already a schema-v2 database. */
export function classifyDatabase(db: Db): "empty" | "current" {
  const version = userVersion(db);
  if (version === 0) {
    if (userTableCount(db) > 0) {
      throw new StorageError("foreign_database",
        "The mission database already contains tables this application did not create. Refusing to modify it.");
    }
    return "empty";
  }
  if (version > SCHEMA_VERSION) {
    throw new StorageError("newer_database",
      `The mission database was created by a newer release (schema ${version}). Update the application before opening it.`);
  }
  if (version < SCHEMA_VERSION) {
    throw new StorageError("damaged_database", `Unsupported mission database schema ${version}.`);
  }
  return "current";
}

/**
 * Creates the schema and seeds the legal run transitions. Call inside the caller's
 * write transaction so that schema, seed data and import commit (or roll back) as one.
 */
export function applySchemaInTransaction(db: Db): void {
  db.exec(SCHEMA_V2_SQL);
  const insert = db.prepare("INSERT INTO team_run_transitions (from_state, to_state) VALUES (?, ?)");
  for (const [from, targets] of Object.entries(TEAM_RUN_TRANSITIONS)) {
    for (const to of targets) insert.run(from, to);
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** The database's legal-transition table must equal the TypeScript constant exactly. */
export function verifyTransitionParity(db: Db): void {
  const stored = (db.prepare("SELECT from_state, to_state FROM team_run_transitions").all() as
    Array<{ from_state: string; to_state: string }>).map(row => `${row.from_state}>${row.to_state}`).sort();
  const expected = Object.entries(TEAM_RUN_TRANSITIONS)
    .flatMap(([from, targets]) => targets.map(to => `${from}>${to}`)).sort();
  if (stored.length !== expected.length || stored.some((value, index) => value !== expected[index])) {
    throw new StorageError("damaged_database",
      "The stored run-transition table does not match this release. Refusing to run.");
  }
}
