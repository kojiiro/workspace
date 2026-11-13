import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./app.js";
import { insertTeamRun, makeTestDir, openStorage, removeTestDir } from "./storage-test-helpers.js";
import type { TestPaths } from "./storage-test-helpers.js";
import type { StorageHandle } from "./storage/index.js";

const host = { host: "127.0.0.1:3001" };
const json = { ...host, "content-type": "application/json" };

async function withApi(run: (ctx: { app: ReturnType<typeof createGateway>; storage: StorageHandle; paths: TestPaths }) => Promise<void>,
  busyTimeoutMs = 200) {
  const paths = await makeTestDir();
  const storage = await openStorage(paths, { busyTimeoutMs });
  const app = createGateway(undefined, { missionRepository: storage.repository });
  try { await run({ app, storage, paths }); } finally { await app.close(); storage.close(); await removeTestDir(paths); }
}

type App = ReturnType<typeof createGateway>;
const post = (app: App, payload: unknown) => app.inject({ method: "POST", url: "/api/missions", headers: json, payload: payload as object });
const patch = (app: App, id: string, payload: unknown, ifMatch?: string) =>
  app.inject({ method: "PATCH", url: `/api/missions/${id}`, headers: ifMatch === undefined ? json : { ...json, "if-match": ifMatch }, payload: payload as object });
const del = (app: App, id: string, ifMatch?: string) =>
  app.inject({ method: "DELETE", url: `/api/missions/${id}`, headers: ifMatch === undefined ? host : { ...host, "if-match": ifMatch } });

test("creating a mission returns revision 1, an ETag, a Location and the default Hal-led team", () => withApi(async ({ app }) => {
  const response = await post(app, { title: "Patrol", notes: "North ridge", assignedNpcId: "john" });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers.etag, '"1"');
  const mission = response.json();
  assert.equal(response.headers.location, "/api/missions/" + mission.id);
  assert.equal(mission.revision, 1);
  assert.equal(mission.leadNpcId, "hal");
  assert.deepEqual(mission.participantNpcIds, ["john", "kyle"]);
  assert.equal(mission.assignedNpcId, "john");

  const single = await app.inject({ method: "GET", url: "/api/missions/" + mission.id, headers: host });
  assert.equal(single.statusCode, 200);
  assert.equal(single.headers.etag, '"1"');
  const list = await app.inject({ method: "GET", url: "/api/missions", headers: host });
  assert.deepEqual(list.json().map((m: { id: string }) => m.id), [mission.id]);
}));

test("PATCH and DELETE require a well-formed If-Match", () => withApi(async ({ app }) => {
  const { id } = (await post(app, { title: "Patrol" })).json();
  const missing = await patch(app, id, { notes: "x" });
  assert.equal(missing.statusCode, 428);
  assert.equal(missing.json().error.code, "precondition_required");
  for (const bad of ["1", 'W/"1"', '"abc"', '"0"', '"-1"', '"1", "2"', "*", '"1.5"', '"9999999999"']) {
    const response = await patch(app, id, { notes: "x" }, bad);
    assert.equal(response.statusCode, 400, "If-Match " + bad);
  }
  assert.equal((await del(app, id)).statusCode, 428);
  assert.equal((await del(app, id, "1")).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/missions/" + id, headers: host })).json().notes, "", "nothing changed");
}));

test("a stale revision gets 409 with the latest mission; a current one succeeds and returns the next ETag", () => withApi(async ({ app }) => {
  const { id } = (await post(app, { title: "Patrol" })).json();
  const ok = await patch(app, id, { title: "Patrol v2", status: "in_progress" }, '"1"');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers.etag, '"2"');
  assert.equal(ok.json().revision, 2);

  const stale = await patch(app, id, { notes: "from an old tab" }, '"1"');
  assert.equal(stale.statusCode, 409);
  const body = stale.json();
  assert.equal(body.error.code, "conflict");
  assert.equal(body.reason, "stale_revision");
  assert.equal(body.current.revision, 2);
  assert.equal(body.current.title, "Patrol v2");
  assert.equal(stale.headers.etag, '"2"');

  const staleDelete = await del(app, id, '"1"');
  assert.equal(staleDelete.statusCode, 409);
  assert.equal(staleDelete.json().reason, "stale_revision");
}));

test("two simultaneous edits with the same revision: exactly one succeeds", () => withApi(async ({ app }) => {
  const { id } = (await post(app, { title: "Patrol" })).json();
  const results = await Promise.all([
    patch(app, id, { notes: "writer one" }, '"1"'),
    patch(app, id, { notes: "writer two" }, '"1"')
  ]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
  const winner = results.find(r => r.statusCode === 200)!.json();
  const final = (await app.inject({ method: "GET", url: "/api/missions/" + id, headers: host })).json();
  assert.equal(final.notes, winner.notes);
  assert.equal(final.revision, 2);
}));

test("editing the team: lead and participants are validated against the Corps roster and the lead rule", () => withApi(async ({ app }) => {
  const { id } = (await post(app, { title: "Patrol" })).json();
  assert.equal((await patch(app, id, { participantNpcIds: ["nobody"] }, '"1"')).statusCode, 400);
  assert.equal((await patch(app, id, { leadNpcId: "nobody" }, '"1"')).statusCode, 400);
  assert.equal((await patch(app, id, { assignedNpcId: "nobody" }, '"1"')).statusCode, 400);
  assert.equal((await patch(app, id, { leadNpcId: "hal", participantNpcIds: ["hal", "john"] }, '"1"')).statusCode, 400);
  assert.equal((await patch(app, id, { leadNpcId: "kyle" }, '"1"')).statusCode, 400, "Kyle is still a participant");
  const ok = await patch(app, id, { leadNpcId: "kyle", participantNpcIds: ["john", "hal"] }, '"1"');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().leadNpcId, "kyle");
  assert.equal((await post(app, { title: "Bad", participantNpcIds: ["john", "john"] })).statusCode, 400);
}));

test("clients cannot set server-owned fields", () => withApi(async ({ app }) => {
  const { id } = (await post(app, { title: "Patrol" })).json();
  for (const payload of [{ revision: 99 }, { id: "x" }, { createdAt: "2020-01-01T00:00:00.000Z" }, { updatedAt: "2020-01-01T00:00:00.000Z" }, {}]) {
    assert.equal((await patch(app, id, payload, '"1"')).statusCode, 400, JSON.stringify(payload));
  }
  assert.equal((await post(app, { title: "X", revision: 5 })).statusCode, 400);
}));

test("an unchanged edit returns the mission without bumping the revision", () => withApi(async ({ app }) => {
  const { id } = (await post(app, { title: "Patrol" })).json();
  const response = await patch(app, id, { title: "Patrol" }, '"1"');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().revision, 1);
}));

test("deleting: 404 for unknown, 409 while a team run is active, 204 once it ends, history removed with it", () => withApi(async ({ app, storage }) => {
  const { id } = (await post(app, { title: "Patrol" })).json();
  insertTeamRun(storage.db, id, "run-1", "awaiting_commander_review");

  const blocked = await del(app, id, '"1"');
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().reason, "active_run");
  assert.equal((await app.inject({ method: "GET", url: "/api/missions/" + id, headers: host })).statusCode, 200);

  storage.db.prepare("UPDATE team_runs SET state='cancelling', version=version+1, end_reason='commander_rejected' WHERE id='run-1'").run();
  storage.db.prepare("UPDATE team_runs SET state='cancelled', version=version+1, completed_at='2026-11-05T10:00:00.000Z' WHERE id='run-1'").run();
  const done = await del(app, id, '"1"');
  assert.equal(done.statusCode, 204);
  assert.equal(done.body, "");
  assert.equal((await app.inject({ method: "GET", url: "/api/missions/" + id, headers: host })).statusCode, 404);
  assert.equal((storage.db.prepare("SELECT count(*) AS c FROM team_events").get() as { c: number }).c, 0);
  assert.equal((await del(app, id, '"1"')).statusCode, 404);
  assert.equal((await del(app, "not-a-uuid", '"1"')).statusCode, 400);
}));

test("missions survive a gateway restart exactly as saved", async () => {
  const paths = await makeTestDir();
  let storage = await openStorage(paths);
  let app = createGateway(undefined, { missionRepository: storage.repository });
  const created = (await post(app, { title: "Persistent", notes: "Remember me", assignedNpcId: "kyle" })).json();
  await patch(app, created.id, { status: "in_progress" }, '"1"');
  await app.close(); storage.close();

  storage = await openStorage(paths);
  app = createGateway(undefined, { missionRepository: storage.repository });
  try {
    const loaded = (await app.inject({ method: "GET", url: "/api/missions/" + created.id, headers: host })).json();
    assert.equal(loaded.title, "Persistent");
    assert.equal(loaded.status, "in_progress");
    assert.equal(loaded.revision, 2);
    assert.deepEqual(loaded.participantNpcIds, ["john", "kyle"]);
  } finally { await app.close(); storage.close(); await removeTestDir(paths); }
});

test("a busy database is a retryable 503 while reads keep working", async () => {
  const paths = await makeTestDir();
  const holder = await openStorage(paths);
  const storage = await openStorage(paths, { busyTimeoutMs: 50 });
  const app = createGateway(undefined, { missionRepository: storage.repository });
  try {
    const { id } = (await post(app, { title: "Patrol" })).json();
    holder.db.exec("BEGIN IMMEDIATE");
    const blocked = await patch(app, id, { notes: "x" }, '"1"');
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error.code, "unavailable");
    assert.equal(blocked.json().error.retryable, true);
    assert.equal((await app.inject({ method: "GET", url: "/api/missions", headers: host })).statusCode, 200);
    holder.db.exec("ROLLBACK");
    assert.equal((await patch(app, id, { notes: "x" }, '"1"')).statusCode, 200);
  } finally { await app.close(); holder.close(); storage.close(); await removeTestDir(paths); }
});

test("storage failures return a generic message and never leak SQL, paths or stack traces", () => withApi(async ({ app, storage }) => {
  storage.db.close();
  const response = await app.inject({ method: "GET", url: "/api/missions", headers: host });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.message, "Local mission storage is unavailable.");
  assert.doesNotMatch(response.body, /sqlite|\.sqlite|headquarters|at .*\.ts/i);
}));

test("Host and Origin protections still cover every mission route", () => withApi(async ({ app }) => {
  const { id } = (await post(app, { title: "Patrol" })).json();
  const evilHost = { host: "evil.example:3001", "if-match": '"1"' };
  const evilOrigin = { ...host, origin: "http://evil.example", "if-match": '"1"', "content-type": "application/json" };
  for (const [method, url] of [["GET", "/api/missions"], ["GET", "/api/missions/" + id], ["DELETE", "/api/missions/" + id]] as const) {
    assert.equal((await app.inject({ method, url, headers: evilHost })).statusCode, 403, method + " bad host");
    assert.equal((await app.inject({ method, url, headers: evilOrigin })).statusCode, 403, method + " bad origin");
  }
  assert.equal((await app.inject({ method: "PATCH", url: "/api/missions/" + id, headers: evilOrigin, payload: { notes: "x" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/missions", headers: evilOrigin, payload: { title: "x" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/missions/" + id, headers: host })).json().notes, "", "untouched");
}));

test("a gateway created without a repository uses a private in-memory store and releases it on close", async () => {
  const app = createGateway();
  const created = await post(app, { title: "Scratch" });
  assert.equal(created.statusCode, 201);
  await app.close();
});
