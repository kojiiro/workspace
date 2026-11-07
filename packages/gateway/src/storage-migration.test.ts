import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sha256Hex } from "./storage/legacy-json.js";
import { initializeStorage, StorageError } from "./storage/index.js";
import {
  ID1, ID2, ID3, envelope, legacyMission, listDir, makeTestDir, openStorage, removeTestDir,
  storageOptions, threeLegacyMissions, writeLegacyFile
} from "./storage-test-helpers.js";
import type { TestPaths } from "./storage-test-helpers.js";

async function withDir(run: (paths: TestPaths) => Promise<void>) {
  const paths = await makeTestDir();
  try { await run(paths); } finally { await removeTestDir(paths); }
}
const exists = (path: string) => stat(path).then(() => true, () => false);

function rawDbState(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      version: Number(db.pragma("user_version", { simple: true })),
      tables: (db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c
    };
  } finally { db.close(); }
}

test("an existing missions.json is backed up, imported with Hal as lead and John+Kyle as participants, then archived", () => withDir(async paths => {
  const original = envelope(threeLegacyMissions());
  await writeLegacyFile(paths, original);
  const storage = await openStorage(paths);
  try {
    assert.equal(storage.report.status, "imported");
    assert.equal(storage.report.importedMissions, 3);
    assert.equal(storage.report.rejectedRecords, 0);

    const missions = await storage.repository.list();
    assert.equal(missions.length, 3);
    const first = missions.find(m => m.id === ID1)!;
    assert.deepEqual(
      { title: first.title, notes: first.notes, assigned: first.assignedNpcId, status: first.status,
        created: first.createdAt, updated: first.updatedAt, lead: first.leadNpcId,
        participants: first.participantNpcIds, revision: first.revision },
      { title: "Survey Sector 2814", notes: "Check the outer perimeter.", assigned: "john", status: "in_progress",
        created: "2026-10-01T08:00:00.000Z", updated: "2026-10-02T09:30:00.000Z", lead: "hal",
        participants: ["john", "kyle"], revision: 1 });
    assert.equal(missions.find(m => m.id === ID3)!.assignedNpcId, "kyle");
    assert.equal(missions.find(m => m.id === ID2)!.assignedNpcId, null);

    // Verified backup: byte-identical copy, digests recorded in the marker row.
    const backups = await listDir(paths.backupDir);
    assert.equal(backups.length, 1);
    const backupBytes = await readFile(join(paths.backupDir, backups[0]));
    assert.equal(backupBytes.toString("utf8"), original);
    const marker = storage.db.prepare("SELECT * FROM schema_migrations WHERE version = 2").get() as Record<string, unknown>;
    assert.equal(marker.source_sha256, sha256Hex(original));
    assert.equal(marker.backup_sha256, sha256Hex(original));
    assert.equal(marker.imported_count, 3);
    assert.equal(marker.rejected_count, 0);
    assert.ok(!String(marker.backup_path).startsWith("/") && !/^[A-Za-z]:/.test(String(marker.backup_path)), "backup path is relative");

    // Archived only after the commit.
    assert.equal(await exists(paths.legacyJsonPath), false);
    assert.equal(await readFile(paths.legacyJsonPath + ".migrated", "utf8"), original);
    assert.equal(storage.report.archivedTo, paths.legacyJsonPath + ".migrated");
  } finally { storage.close(); }
}));

test("the original bare-array layout and a UTF-8 byte-order mark (common on Windows) both import", () => withDir(async paths => {
  await writeLegacyFile(paths, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(threeLegacyMissions()))]));
  const storage = await openStorage(paths);
  try {
    assert.equal(storage.report.importedMissions, 3);
    assert.equal((await storage.repository.list()).length, 3);
  } finally { storage.close(); }
}));

test("invalid and duplicate records are quarantined once, valid ones are imported", () => withDir(async paths => {
  const bad = { id: ID2, title: "No dates" };
  const wrongTypes = legacyMission({ id: ID3, assignedNpcId: 5, status: "fake" });
  const duplicate = legacyMission({ title: "Same ID again" });
  await writeLegacyFile(paths, envelope([legacyMission(), bad, wrongTypes, duplicate, bad]));
  const storage = await openStorage(paths);
  try {
    assert.equal(storage.report.importedMissions, 1);
    assert.equal(storage.report.rejectedRecords, 4);
    assert.deepEqual((await storage.repository.list()).map(m => m.title), ["Survey Sector 2814"]);
    // Identical bad records collapse into one quarantine row (content hash is the key).
    assert.equal((storage.db.prepare("SELECT count(*) AS c FROM rejected_records").get() as { c: number }).c, 3);
    const row = storage.db.prepare("SELECT reason, raw_json FROM rejected_records WHERE raw_json LIKE '%No dates%'").get() as { reason: string; raw_json: string };
    assert.match(row.reason, /updatedAt|createdAt/);
    assert.equal(JSON.parse(row.raw_json).title, "No dates");
  } finally { storage.close(); }
}));

test("damaged, empty or unknown-version files fail closed: nothing created, nothing changed, then a fix recovers", () => withDir(async paths => {
  const cases: Array<[string, string]> = [
    ["not JSON", "{ not json"], ["empty file", ""], ["future schema", JSON.stringify({ schemaVersion: 2, missions: [] })],
    ["unknown layout", JSON.stringify({ schemaVersion: 1, missions: [], surprise: true })]
  ];
  for (const [label, content] of cases) {
    await writeLegacyFile(paths, content);
    await assert.rejects(openStorage(paths),
      (error: unknown) => error instanceof StorageError && error.code === "legacy_unreadable", label);
    assert.equal(await readFile(paths.legacyJsonPath, "utf8"), content, label + ": source untouched");
    assert.deepEqual(await listDir(paths.backupDir), [], label + ": no backup clutter");
    if (await exists(paths.databasePath)) assert.deepEqual(rawDbState(paths.databasePath), { version: 0, tables: 0 }, label);
  }
  await writeLegacyFile(paths, envelope(threeLegacyMissions()));
  const storage = await openStorage(paths);
  try { assert.equal(storage.report.importedMissions, 3); } finally { storage.close(); }
}));

test("a backup that does not verify aborts the migration; nothing imported, original untouched, corrupt copy removed", () => withDir(async paths => {
  const original = envelope(threeLegacyMissions());
  await writeLegacyFile(paths, original);
  await assert.rejects(
    openStorage(paths, { hooks: { afterBackupWritten: async path => { await writeFile(path, "corrupted", { flag: "a" }); } } }),
    (error: unknown) => error instanceof StorageError && error.code === "backup_failed");
  assert.equal(await readFile(paths.legacyJsonPath, "utf8"), original);
  assert.deepEqual(await listDir(paths.backupDir), []);
  assert.deepEqual(rawDbState(paths.databasePath), { version: 0, tables: 0 });
  const storage = await openStorage(paths);   // a clean retry works
  try { assert.equal(storage.report.importedMissions, 3); } finally { storage.close(); }
}));

test("a failure right before COMMIT rolls everything back and the retry reuses the same verified backup", () => withDir(async paths => {
  const original = envelope(threeLegacyMissions());
  await writeLegacyFile(paths, original);
  const failing = { hooks: { beforeCommit: () => { throw new Error("simulated failure before commit"); } } };
  await assert.rejects(openStorage(paths, failing), /simulated failure/);
  await assert.rejects(openStorage(paths, failing), /simulated failure/);
  assert.equal(await readFile(paths.legacyJsonPath, "utf8"), original);
  assert.deepEqual(rawDbState(paths.databasePath), { version: 0, tables: 0 });
  assert.equal((await listDir(paths.backupDir)).length, 1, "repeated failures do not pile up backups");
  const storage = await openStorage(paths);
  try {
    assert.equal(storage.report.importedMissions, 3);
    assert.equal((await listDir(paths.backupDir)).length, 1);
    assert.equal((storage.db.prepare("SELECT count(*) AS c FROM schema_migrations").get() as { c: number }).c, 1);
  } finally { storage.close(); }
}));

test("a hard process kill (SIGKILL) inside the import transaction leaves the old file and a clean database", () => withDir(async paths => {
  const original = envelope(threeLegacyMissions());
  await writeLegacyFile(paths, original);
  const gatewayDir = fileURLToPath(new URL("..", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", "tsx", join("src", "storage-crash-child.ts"), paths.dir],
    { cwd: gatewayDir, encoding: "utf8", timeout: 60_000 });
  assert.ok(child.status !== 0 || child.signal, "the child must not exit normally");
  assert.equal(await exists(join(paths.dir, "reached-before-commit.flag")), true,
    "child died at the intended point: " + (child.stderr || "").slice(0, 300));
  assert.equal(await readFile(paths.legacyJsonPath, "utf8"), original);
  assert.equal(await exists(paths.legacyJsonPath + ".migrated"), false);
  const storage = await openStorage(paths);
  try {
    assert.equal(storage.report.status, "imported");
    assert.equal((await storage.repository.list()).length, 3);
  } finally { storage.close(); }
}));

test("if archiving fails after a successful import, startup still works, the file is never re-imported, and the archive is retried", () => withDir(async paths => {
  const original = envelope(threeLegacyMissions());
  await writeLegacyFile(paths, original);
  const denied = () => Promise.reject(Object.assign(new Error("denied"), { code: "EPERM" }));
  const first = await openStorage(paths, { hooks: { renameLegacy: denied } });
  try {
    assert.equal(first.report.importedMissions, 3);
    assert.equal(first.report.archivedTo, null);
    assert.ok(first.report.warnings.some(w => /safe in the database/.test(w)));
    assert.equal(await exists(paths.legacyJsonPath), true);
    await first.repository.create({ title: "Added after the import", notes: "", assignedNpcId: null });
  } finally { first.close(); }

  const second = await openStorage(paths);
  try {
    assert.equal(second.report.status, "already-initialized");
    assert.equal((await second.repository.list()).length, 4, "no duplicates, new work kept");
    assert.equal(second.report.archivedTo, paths.legacyJsonPath + ".migrated");
    assert.equal(await exists(paths.legacyJsonPath), false);
  } finally { second.close(); }
}));

test("a transient rename failure (antivirus or indexer on Windows) is retried", () => withDir(async paths => {
  await writeLegacyFile(paths, envelope(threeLegacyMissions()));
  let calls = 0;
  const { rename } = await import("node:fs/promises");
  const flaky = async (from: string, to: string) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    await rename(from, to);
  };
  const storage = await openStorage(paths, { hooks: { renameLegacy: flaky } });
  try {
    assert.equal(calls, 3);
    assert.equal(storage.report.archivedTo, paths.legacyJsonPath + ".migrated");
  } finally { storage.close(); }
}));

test("a different missions.json appearing later never overrides the database", () => withDir(async paths => {
  await writeLegacyFile(paths, envelope(threeLegacyMissions()));
  (await openStorage(paths)).close();
  const changed = envelope([legacyMission({ id: "44444444-4444-4444-8444-444444444444", title: "Sneaked in" })]);
  await writeLegacyFile(paths, changed);
  const storage = await openStorage(paths);
  try {
    assert.equal(storage.report.status, "already-initialized");
    assert.ok(storage.report.warnings.some(w => /authoritative/.test(w)));
    assert.equal((await storage.repository.list()).length, 3);
    assert.equal(await readFile(paths.legacyJsonPath, "utf8"), changed, "left untouched");
  } finally { storage.close(); }
}));

test("a fresh install records an empty marker, and a later missions.json is ignored with a warning", () => withDir(async paths => {
  const first = await openStorage(paths);
  try {
    assert.equal(first.report.status, "initialized-empty");
    const marker = first.db.prepare("SELECT * FROM schema_migrations WHERE version = 2").get() as Record<string, unknown>;
    assert.equal(marker.source_sha256, null);
    assert.equal(marker.imported_count, 0);
  } finally { first.close(); }
  await writeLegacyFile(paths, envelope(threeLegacyMissions()));
  const second = await openStorage(paths);
  try {
    assert.equal((await second.repository.list()).length, 0);
    assert.equal(second.report.warnings.length, 1);
  } finally { second.close(); }
}));

test("two gateways starting together import once: the second sees the finished database", () => withDir(async paths => {
  await writeLegacyFile(paths, envelope(threeLegacyMissions()));
  let secondReport: string | undefined;
  const first = await initializeStorage(storageOptions(paths, {
    hooks: {
      beforeTransaction: async () => {
        const second = await initializeStorage(storageOptions(paths));
        secondReport = second.report.status;
        second.close();
      }
    }
  }));
  try {
    assert.equal(secondReport, "imported");
    assert.equal(first.report.status, "already-initialized");
    assert.equal((await first.repository.list()).length, 3, "imported exactly once");
    assert.equal((first.db.prepare("SELECT count(*) AS c FROM schema_migrations").get() as { c: number }).c, 1);
    assert.equal((await listDir(paths.backupDir)).length, 1);
  } finally { first.close(); }
}));

test("a database from a newer release is refused and left alone", () => withDir(async paths => {
  const raw = new Database(paths.databasePath);
  raw.pragma("user_version = 3");
  raw.close();
  await assert.rejects(openStorage(paths), (e: unknown) => e instanceof StorageError && e.code === "newer_database");
  assert.equal(rawDbState(paths.databasePath).version, 3);
}));

test("a realistic board (500 missions) imports and verifies", () => withDir(async paths => {
  const many = Array.from({ length: 500 }, (_, i) => legacyMission({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, title: `Mission ${i}`, notes: "n".repeat(900),
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString()
  }));
  await writeLegacyFile(paths, envelope(many));
  const started = Date.now();
  const storage = await openStorage(paths);
  try {
    assert.equal(storage.report.importedMissions, 500);
    assert.equal((await storage.repository.list()).length, 500);
    assert.ok(Date.now() - started < 10_000);
  } finally { storage.close(); }
}));

test("a damaged database file gets restore guidance and is left byte-for-byte untouched", () => withDir(async paths => {
  await writeFile(paths.databasePath, Buffer.alloc(4096, 0x41));   // not a SQLite file
  const before = await readFile(paths.databasePath);
  await assert.rejects(openStorage(paths), (error: unknown) =>
    error instanceof StorageError && error.code === "damaged_database" && /Restore the newest headquarters-\*\.sqlite/.test(error.message));
  assert.deepEqual(await readFile(paths.databasePath), before);
}));

test("the backup path recorded in the marker uses forward slashes on every platform", () => withDir(async paths => {
  await writeLegacyFile(paths, envelope(threeLegacyMissions()));
  const storage = await openStorage(paths);
  try {
    const marker = storage.db.prepare("SELECT backup_path FROM schema_migrations WHERE version = 2").get() as { backup_path: string };
    assert.match(marker.backup_path, /^backups\/missions\.v1-\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/);
  } finally { storage.close(); }
}));
