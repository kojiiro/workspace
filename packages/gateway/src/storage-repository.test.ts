import test from "node:test";
import assert from "node:assert/strict";
import { isBusyError, StorageError } from "./storage/index.js";
import {
  insertTeamRun, makeTestDir, openStorage, removeTestDir, threeLegacyMissions, envelope, writeLegacyFile, ID1, ID2
} from "./storage-test-helpers.js";
import type { TestPaths } from "./storage-test-helpers.js";
import type { StorageHandle } from "./storage/index.js";

async function withStorage(run: (storage: StorageHandle, paths: TestPaths) => Promise<void>) {
  const paths = await makeTestDir();
  const storage = await openStorage(paths);
  try { await run(storage, paths); } finally { storage.close(); await removeTestDir(paths); }
}
const input = (title: string, extra = {}) => ({ title, notes: "", assignedNpcId: null, ...extra });
const invalidChange = (error: unknown) => error instanceof StorageError && error.code === "invalid_change";

test("new missions start at revision 1 with Hal leading John and Kyle", () => withStorage(async ({ repository }) => {
  const mission = await repository.create(input("Patrol"));
  assert.equal(mission.revision, 1);
  assert.equal(mission.status, "planned");
  assert.equal(mission.leadNpcId, "hal");
  assert.deepEqual(mission.participantNpcIds, ["john", "kyle"]);
  assert.deepEqual(await repository.get(mission.id), mission);
  assert.equal(await repository.get("00000000-0000-4000-8000-000000000000"), null);
}));

test("updates bump the revision and a stale revision is rejected with the current mission", () => withStorage(async ({ repository }) => {
  const created = await repository.create(input("Patrol"));
  const updated = await repository.update(created.id, 1, { title: "Patrol sector 7", status: "in_progress" });
  assert.ok(updated.ok);
  assert.equal(updated.mission.revision, 2);
  assert.equal(updated.mission.title, "Patrol sector 7");
  assert.equal(updated.changed, true);
  assert.ok(updated.mission.updatedAt >= created.updatedAt);

  const stale = await repository.update(created.id, 1, { notes: "from an old tab" });
  assert.ok(!stale.ok && stale.reason === "stale_revision");
  assert.equal(stale.current.revision, 2);
  assert.equal(stale.current.title, "Patrol sector 7");
  assert.equal((await repository.get(created.id))!.notes, "", "the stale write changed nothing");

  const missing = await repository.update("00000000-0000-4000-8000-000000000000", 1, { notes: "x" });
  assert.ok(!missing.ok && missing.reason === "not_found");
}));

test("a change that alters nothing does not bump the revision", () => withStorage(async ({ repository }) => {
  const created = await repository.create(input("Patrol"));
  const same = await repository.update(created.id, 1, { title: "Patrol", participantNpcIds: ["john", "kyle"] });
  assert.ok(same.ok);
  assert.equal(same.changed, false);
  assert.equal(same.mission.revision, 1);
}));

test("participants can be replaced, reordered and the lead changed in one atomic edit", () => withStorage(async ({ repository }) => {
  const created = await repository.create(input("Patrol"));
  const swapped = await repository.update(created.id, 1, { participantNpcIds: ["kyle", "john"] });
  assert.ok(swapped.ok);
  assert.deepEqual(swapped.mission.participantNpcIds, ["kyle", "john"]);

  // Make Kyle the lead: he must leave the participant list in the same edit.
  const reassigned = await repository.update(created.id, 2, { leadNpcId: "kyle", participantNpcIds: ["john", "hal"] });
  assert.ok(reassigned.ok);
  assert.equal(reassigned.mission.leadNpcId, "kyle");
  assert.deepEqual(reassigned.mission.participantNpcIds, ["john", "hal"]);
  assert.equal(reassigned.mission.revision, 3);
}));

test("rule violations are refused and leave the mission exactly as it was", () => withStorage(async ({ repository }) => {
  const created = await repository.create(input("Patrol"));
  await assert.rejects(repository.update(created.id, 1, { leadNpcId: "kyle" }), invalidChange);         // Kyle is still a participant
  await assert.rejects(repository.update(created.id, 1, { participantNpcIds: ["john", "john"] }), invalidChange);
  await assert.rejects(repository.update(created.id, 1, { participantNpcIds: [] }), invalidChange);
  await assert.rejects(repository.update(created.id, 1, { participantNpcIds: ["a", "b", "c", "d", "e"] }), invalidChange);
  await assert.rejects(repository.update(created.id, 1, { participantNpcIds: ["hal"] }), invalidChange); // lead as participant
  await assert.rejects(repository.create(input("Bad", { participantNpcIds: ["hal"] })), invalidChange);
  assert.deepEqual(await repository.get(created.id), created);
  assert.equal((await repository.list()).length, 1);
}));

test("missions list newest-updated first", () => withStorage(async ({ repository }) => {
  const a = await repository.create(input("A"));
  const b = await repository.create(input("B"));
  await new Promise(resolve => setTimeout(resolve, 5));
  await repository.update(a.id, 1, { notes: "touched" });
  assert.deepEqual((await repository.list()).map(m => m.title), ["A", "B"]);
  assert.ok(b);
}));

test("deleting requires the current revision", () => withStorage(async ({ repository }) => {
  const created = await repository.create(input("Patrol"));
  await repository.update(created.id, 1, { notes: "changed" });
  const stale = await repository.delete(created.id, 1);
  assert.ok(!stale.ok && stale.reason === "stale_revision");
  assert.ok(await repository.get(created.id), "still there");
  const done = await repository.delete(created.id, 2);
  assert.ok(done.ok);
  assert.equal(await repository.get(created.id), null);
  const again = await repository.delete(created.id, 2);
  assert.ok(!again.ok && again.reason === "not_found");
}));

test("deleting a mission removes its participants, runs, steps, attempts and events, and nothing else", () => withStorage(async ({ repository, db }) => {
  const doomed = await repository.create(input("Doomed"));
  const survivor = await repository.create(input("Survivor"));
  insertTeamRun(db, doomed.id, "run-d1", "completed");
  insertTeamRun(db, doomed.id, "run-d2", "cancelled");
  insertTeamRun(db, survivor.id, "run-s1", "completed");
  assert.deepEqual(await repository.historyCounts(doomed.id), { runs: 2, events: 2 });

  const outcome = await repository.delete(doomed.id, 1);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.removed, { runs: 2, events: 2 });
  const count = (table: string, where = "1=1") => (db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: number }).c;
  assert.equal(count("team_runs"), 1);
  assert.equal(count("team_steps"), 1);
  assert.equal(count("team_step_attempts"), 1);
  assert.equal(count("team_events"), 1);
  assert.equal(count("mission_participants", `mission_id = '${doomed.id}'`), 0);
  assert.equal(count("mission_participants", `mission_id = '${survivor.id}'`), 2);
  assert.deepEqual((await repository.get(survivor.id))!, survivor);
}));

test("a mission with an active team run cannot be deleted, in any non-terminal state", () => withStorage(async ({ repository, db }) => {
  for (const state of ["queued", "planning", "working", "reviewing", "revising", "awaiting_commander_review", "paused", "cancelling"]) {
    const mission = await repository.create(input("Active " + state));
    insertTeamRun(db, mission.id, "run-" + state, state);
    const outcome = await repository.delete(mission.id, 1);
    assert.ok(!outcome.ok && outcome.reason === "active_run", state);
    assert.ok(await repository.get(mission.id), state + " still exists");
  }
  const finished = await repository.create(input("Finished"));
  insertTeamRun(db, finished.id, "run-finished", "failed");
  assert.ok((await repository.delete(finished.id, 1)).ok);
}));

test("the database itself also blocks deleting a mission with an active run", () => withStorage(async ({ repository, db }) => {
  const mission = await repository.create(input("Guarded"));
  insertTeamRun(db, mission.id, "run-x", "working");
  assert.throws(() => db.prepare("DELETE FROM missions WHERE id = ?").run(mission.id), /active team run/);
}));

test("two connections editing the same revision: exactly one wins, the other gets a conflict", async () => {
  const paths = await makeTestDir();
  await writeLegacyFile(paths, envelope(threeLegacyMissions()));
  const a = await openStorage(paths);
  const b = await openStorage(paths);
  try {
    const first = await a.repository.update(ID1, 1, { notes: "from A" });
    const second = await b.repository.update(ID1, 1, { notes: "from B" });
    assert.ok(first.ok);
    assert.ok(!second.ok && second.reason === "stale_revision");
    assert.equal(second.current.notes, "from A");
    assert.equal((await b.repository.get(ID1))!.notes, "from A", "nothing lost, B's edit never applied");
  } finally { a.close(); b.close(); await removeTestDir(paths); }
});

test("a locked database surfaces as a retryable busy error, not corruption", async () => {
  const paths = await makeTestDir();
  await writeLegacyFile(paths, envelope(threeLegacyMissions()));
  const holder = await openStorage(paths);
  const writer = await openStorage(paths, { busyTimeoutMs: 50 });
  try {
    holder.db.exec("BEGIN IMMEDIATE");
    await assert.rejects(writer.repository.update(ID2, 1, { notes: "blocked" }), (error: unknown) => isBusyError(error));
    assert.ok((await writer.repository.list()).length === 3, "readers are not blocked in WAL mode");
    holder.db.exec("ROLLBACK");
    assert.ok((await writer.repository.update(ID2, 1, { notes: "now fine" })).ok);
  } finally { holder.close(); writer.close(); await removeTestDir(paths); }
});

test("a stored row that no longer matches the contract is reported, not served", () => withStorage(async ({ repository, db }) => {
  const mission = await repository.create(input("Tampered"));
  db.pragma("ignore_check_constraints = ON");
  db.prepare("UPDATE missions SET status = 'bogus' WHERE id = ?").run(mission.id);
  db.pragma("ignore_check_constraints = OFF");
  await assert.rejects(repository.get(mission.id), (e: unknown) => e instanceof StorageError && e.code === "corrupt_row");
}));
