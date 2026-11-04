-- PROPOSAL ONLY — Prototype 0.4 SQLite schema, NOT applied by this PR.
-- Requires better-sqlite3 with PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL.
-- Run the DDL in one controlled migration transaction (after selecting journal mode).
-- Base design: one data/headquarters.sqlite file, imported from data/missions.json.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  source_sha256 TEXT
);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  notes TEXT NOT NULL CHECK (length(notes) <= 1000),
  assigned_npc_id TEXT,
  lead_npc_id TEXT NOT NULL DEFAULT 'hal',
  status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'completed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_participants (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  npc_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  PRIMARY KEY (mission_id, npc_id),
  UNIQUE (mission_id, position)
);

CREATE TABLE IF NOT EXISTS team_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued','planning','working','reviewing','revising',
    'awaiting_commander_review','paused','cancelling',
    'completed','cancelled','failed'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  round INTEGER NOT NULL DEFAULT 0 CHECK (round BETWEEN 0 AND 2),
  mode TEXT NOT NULL CHECK (mode IN ('mock','live')),
  paused_from TEXT,
  snapshot_title TEXT NOT NULL,
  snapshot_notes TEXT NOT NULL,
  snapshot_lead_npc_id TEXT NOT NULL,
  snapshot_participants_json TEXT NOT NULL CHECK (json_valid(snapshot_participants_json)),
  frozen_limits_json TEXT NOT NULL CHECK (json_valid(frozen_limits_json)),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (mission_id, client_request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_team_run_per_mission
  ON team_runs(mission_id)
  WHERE state IN (
    'queued','planning','working','reviewing','revising',
    'awaiting_commander_review','paused','cancelling'
  );

CREATE TABLE IF NOT EXISTS team_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
  npc_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  round INTEGER NOT NULL CHECK (round BETWEEN 0 AND 2),
  status TEXT NOT NULL CHECK (
    status IN ('pending','running','succeeded','failed','skipped','discarded')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, position, round)
);

CREATE TABLE IF NOT EXISTS team_step_attempts (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES team_steps(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  state TEXT NOT NULL CHECK (
    state IN ('running','succeeded','failed','discarded')
  ),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  UNIQUE (step_id, attempt_no)
);

-- Global cursor survives gateway restarts; each run has a separate sequence.
-- Do not insert one row per streaming token. Insert one row per committed step.
CREATE TABLE IF NOT EXISTS team_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
  -- Immutable audit metadata; using ON DELETE SET NULL here would mutate
  -- event rows and conflict with the append-only update trigger on cascade.
  -- The run FK handles transcript removal for confirmed mission deletion.
  step_id TEXT,
  attempt_id TEXT,
  parent_event_uuid TEXT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  round INTEGER NOT NULL CHECK (round BETWEEN 0 AND 2),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_actor_json TEXT NOT NULL CHECK (json_valid(from_actor_json)),
  to_actors_json TEXT NOT NULL CHECK (json_valid(to_actors_json)),
  text TEXT NOT NULL CHECK (length(text) <= 6000),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS team_events_by_mission_cursor
  ON team_events(mission_id, cursor);

-- Invalid legacy JSON records are stored once, keyed by content digest.
CREATE TABLE IF NOT EXISTS rejected_records (
  content_sha256 TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_position INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  error_summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Event records cannot be edited after commit.
CREATE TRIGGER IF NOT EXISTS team_events_no_update
  BEFORE UPDATE ON team_events
  BEGIN SELECT RAISE(ABORT, 'Team events are append-only'); END;

-- Cascade deletion of a mission is the ONLY permitted path for event deletion.
-- The backend must insert a row in this table in the SAME transaction after
-- the commander confirms deletion, check no active run, delete the mission,
-- then remove the authorization row before COMMIT. A failed transaction rolls
-- back the authorization as well as the deletion.
CREATE TABLE IF NOT EXISTS authorized_mission_deletions (
  mission_id TEXT PRIMARY KEY
);
CREATE TRIGGER IF NOT EXISTS team_events_no_direct_delete
  BEFORE DELETE ON team_events
  WHEN NOT EXISTS (
    SELECT 1 FROM authorized_mission_deletions a
    WHERE a.mission_id = OLD.mission_id
  )
  BEGIN SELECT RAISE(ABORT, 'Team event deletion requires mission confirmation'); END;

-- NOTE: test trigger/cascade semantics and deletion authorization on both OSes.
-- NOTE: missions.active_run_id must be updated transactionally and checked to
--       refer to the run selected by the active-run index. This is a cached
--       pointer, not a substitute for the database uniqueness constraint.
