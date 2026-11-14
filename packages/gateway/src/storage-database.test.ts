import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { TEAM_RUN_TRANSITIONS } from "@glc/shared";
import {
  applySchemaInTransaction, assertConnectionSafety, classifyDatabase, openDatabase, userVersion,
  verifyTransitionParity
} from "./storage/database.js";
import { createDatabaseBackup } from "./storage/backup.js";
import { SCHEMA_V2_SQL } from "./storage/schema.generated.js";
import { StorageError } from "./storage/index.js";
import { ID1, legacyMission, makeTestDir, openStorage, removeTestDir, writeLegacyFile, envelope } from "./storage-test-helpers.js";

test("a file database opens with every required safety setting and reads them back", async () => {
  const paths = await makeTestDir();
  const db = openDatabase({ path: paths.databasePath });
  try {
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("recursive_triggers", { simple: true }), 1);
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("synchronous", { simple: true }), 2);
  } finally { db.close(); await removeTestDir(paths); }
});

test("a connection missing a required setting is refused", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = OFF");
    assert.throws(() => assertConnectionSafety(db, false),
      (error: unknown) => error instanceof StorageError && error.code === "unsafe_connection");
  } finally { db.close(); }
});

test("schema creation, seed data and user_version commit or roll back together", () => {
  const db = openDatabase({ path: ":memory:" });
  try {
    assert.throws(() => db.transaction(() => { applySchemaInTransaction(db); throw new Error("crash mid-migration"); })());
    assert.equal(userVersion(db), 0);
    assert.equal((db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { c: number }).c, 0);
    db.transaction(() => applySchemaInTransaction(db))();
    assert.equal(userVersion(db), 2);
    assert.equal(classifyDatabase(db), "current");
  } finally { db.close(); }
});

test("databases that are foreign or newer are refused untouched", () => {
  const foreign = openDatabase({ path: ":memory:" });
  const newer = openDatabase({ path: ":memory:" });
  try {
    foreign.exec("CREATE TABLE somebody_elses_table (x)");
    assert.throws(() => classifyDatabase(foreign), (e: unknown) => e instanceof StorageError && e.code === "foreign_database");
    newer.pragma("user_version = 3");
    assert.throws(() => classifyDatabase(newer), (e: unknown) => e instanceof StorageError && e.code === "newer_database");
  } finally { foreign.close(); newer.close(); }
});

test("the stored run-transition table equals the TypeScript constant and tampering is detected", () => {
  const db = openDatabase({ path: ":memory:" });
  try {
    db.transaction(() => applySchemaInTransaction(db))();
    verifyTransitionParity(db);
    const count = (db.prepare("SELECT count(*) AS c FROM team_run_transitions").get() as { c: number }).c;
    assert.equal(count, Object.values(TEAM_RUN_TRANSITIONS).reduce((sum, targets) => sum + targets.length, 0));
    db.prepare("DELETE FROM team_run_transitions WHERE from_state = 'working' AND to_state = 'reviewing'").run();
    assert.throws(() => verifyTransitionParity(db), (e: unknown) => e instanceof StorageError && e.code === "damaged_database");
  } finally { db.close(); }
});

test("the reviewed docs/sqlite-team-schema.sql is exactly what the application embeds", async () => {
  const docsPath = fileURLToPath(new URL("../../../docs/sqlite-team-schema.sql", import.meta.url));
  const docs = (await readFile(docsPath, "utf8")).replace(/\r\n/g, "\n");
  assert.equal(SCHEMA_V2_SQL, docs, "Run npm run schema:sync after editing docs/sqlite-team-schema.sql");
});

test("INSERT OR REPLACE cannot rewrite a team event on a production connection", async () => {
  const paths = await makeTestDir();
  const storage = await openStorage(paths);
  try {
    const { db } = storage;
    const now = "2026-11-05T10:00:00.000Z";
    db.prepare("INSERT INTO missions (id, title, notes, lead_npc_id, status, created_at, updated_at) VALUES ('m','t','','hal','planned',?,?)").run(now, now);
    db.prepare(`INSERT INTO team_runs (id, mission_id, client_request_id, state, mode, snapshot_json, started_at, updated_at)
                VALUES ('r','m','c','working','mock','{}',?,?)`).run(now, now);
    const insert = `INSERT OR REPLACE INTO team_events (event_uuid, mission_id, run_id, sequence, round, at, kind,
        from_actor_json, to_actors_json, text, provenance_json) VALUES (?, 'm', 'r', 1, 0, ?, 'status', '{}', '[]', ?, '{}')`;
    db.prepare(insert).run("e1", now, "original");
    assert.throws(() => db.prepare(insert).run("forged", now, "FORGED"));
    assert.equal((db.prepare("SELECT text FROM team_events WHERE sequence = 1").get() as { text: string }).text, "original");
  } finally { storage.close(); await removeTestDir(paths); }
});

test("a live database is backed up consistently, including data still in the WAL", async () => {
  const paths = await makeTestDir();
  await writeLegacyFile(paths, envelope([legacyMission()]));
  const storage = await openStorage(paths);
  try {
    await storage.repository.create({ title: "Written after the import", notes: "", assignedNpcId: null });
    const backupPath = createDatabaseBackup(storage.db, paths.backupDir, new Date("2026-11-05T11:00:00.000Z"));
    const copy = new Database(backupPath, { readonly: true });
    try {
      const titles = (copy.prepare("SELECT title FROM missions ORDER BY title").all() as Array<{ title: string }>).map(r => r.title);
      assert.deepEqual(titles, ["Survey Sector 2814", "Written after the import"]);
      assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
    } finally { copy.close(); }
  } finally { storage.close(); await removeTestDir(paths); }
});

test("opening an initialised database again is idempotent and releases its files on close", async () => {
  const paths = await makeTestDir();
  const first = await openStorage(paths);
  assert.equal(first.report.status, "initialized-empty");
  await first.repository.create({ title: "Keep me", notes: "", assignedNpcId: null });
  first.close();
  const second = await openStorage(paths);
  try {
    assert.equal(second.report.status, "already-initialized");
    assert.equal((await second.repository.list()).length, 1);
    assert.equal((second.db.prepare("SELECT count(*) AS c FROM schema_migrations").get() as { c: number }).c, 1);
    verifyTransitionParity(second.db);
  } finally { second.close(); }
  await removeTestDir(paths);   // fails on Windows if any handle is still open
  assert.ok(ID1);
});
