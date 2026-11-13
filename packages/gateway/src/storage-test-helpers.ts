import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStorage } from "./storage/index.js";
import type { InitializeStorageOptions, StorageHandle } from "./storage/index.js";

export const FIXED_NOW = () => new Date("2026-11-05T10:00:00.000Z");

export const ID1 = "11111111-1111-4111-8111-111111111111";
export const ID2 = "22222222-2222-4222-8222-222222222222";
export const ID3 = "33333333-3333-4333-8333-333333333333";

export interface TestPaths {
  dir: string;
  databasePath: string;
  legacyJsonPath: string;
  backupDir: string;
}

export async function makeTestDir(): Promise<TestPaths> {
  const dir = await mkdtemp(join(tmpdir(), "glc-storage-"));
  return {
    dir,
    databasePath: join(dir, "headquarters.sqlite"),
    legacyJsonPath: join(dir, "missions.json"),
    backupDir: join(dir, "backups")
  };
}

/** Removes the temp folder. On Windows this only succeeds when every SQLite handle was closed. */
export async function removeTestDir(paths: TestPaths): Promise<void> {
  await rm(paths.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export function legacyMission(overrides: Record<string, unknown> = {}) {
  return {
    id: ID1, title: "Survey Sector 2814", notes: "Check the outer perimeter.",
    assignedNpcId: "john", status: "in_progress",
    createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-02T09:30:00.000Z",
    ...overrides
  };
}

export function threeLegacyMissions() {
  return [
    legacyMission(),
    legacyMission({ id: ID2, title: "Recalibrate the power battery", notes: "", assignedNpcId: null, status: "planned",
      createdAt: "2026-10-03T08:00:00.000Z", updatedAt: "2026-10-03T08:00:00.000Z" }),
    legacyMission({ id: ID3, title: "File the Corps report", notes: "Weekly summary", assignedNpcId: "kyle", status: "completed",
      createdAt: "2026-10-04T08:00:00.000Z", updatedAt: "2026-10-05T12:00:00.000Z" })
  ];
}

export const envelope = (missions: unknown[]) => JSON.stringify({ schemaVersion: 1, missions }, null, 2);

export async function writeLegacyFile(paths: TestPaths, content: string | Buffer): Promise<void> {
  await writeFile(paths.legacyJsonPath, content);
}

export async function listDir(path: string): Promise<string[]> {
  return readdir(path).catch(() => []);
}

export function storageOptions(paths: TestPaths, extra: Partial<InitializeStorageOptions> = {}): InitializeStorageOptions {
  return {
    databasePath: paths.databasePath, legacyJsonPath: paths.legacyJsonPath, backupDir: paths.backupDir,
    now: FIXED_NOW, busyTimeoutMs: 200, ...extra
  };
}

export async function openStorage(paths: TestPaths, extra: Partial<InitializeStorageOptions> = {}): Promise<StorageHandle> {
  return initializeStorage(storageOptions(paths, extra));
}

/** Inserts a team run in the given state (plus a step, attempt and event) for deletion tests. */
export function insertTeamRun(db: StorageHandle["db"], missionId: string, runId: string, state: string): void {
  const now = "2026-11-05T10:00:00.000Z";
  const terminal = ["completed", "cancelled", "failed"].includes(state);
  db.prepare(
    `INSERT INTO team_runs (id, mission_id, client_request_id, state, version, round, mode, paused_from,
       end_reason, snapshot_json, started_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 1, 0, 'mock', ?, ?, '{}', ?, ?, ?)`
  ).run(runId, missionId, runId, state, state === "paused" ? "working" : null,
    terminal ? (state === "completed" ? "approved" : "commander_cancelled") : null, now, now, terminal ? now : null);
  db.prepare(
    "INSERT INTO team_steps (id, run_id, npc_id, position, round, status, created_at, updated_at) VALUES (?, ?, 'john', 0, 0, 'succeeded', ?, ?)"
  ).run(runId + "-s", runId, now, now);
  db.prepare(
    "INSERT INTO team_step_attempts (id, step_id, attempt_no, state, started_at) VALUES (?, ?, 1, 'succeeded', ?)"
  ).run(runId + "-a", runId + "-s", now);
  db.prepare(
    `INSERT INTO team_events (event_uuid, mission_id, run_id, step_id, attempt_id, sequence, round, at, kind,
       from_actor_json, to_actors_json, text, provenance_json)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, 'contribution', '{}', '[]', 'hello', '{}')`
  ).run(runId + "-e", missionId, runId, runId + "-s", runId + "-a", now);
}
