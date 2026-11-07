-- Prototype 0.4 team-mission schema (user_version 2).
-- Applied by the gateway storage layer (packages/gateway/src/storage) inside ONE
-- migration transaction. This file is the source of truth: run
-- "npm run schema:sync" to regenerate packages/gateway/src/storage/schema.generated.ts,
-- and a test fails if the two ever differ.
-- REQUIRED on EVERY SQLite connection, before any statement:
-- PRAGMA foreign_keys = ON; assert value == 1 at startup.
-- PRAGMA recursive_triggers = ON; assert value == 1 at startup.
-- PRAGMA journal_mode = WAL; verify WAL actually enabled on the file DB.
-- Seed team_run_transitions from TEAM_RUN_TRANSITIONS and assert exact parity.

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  notes TEXT NOT NULL CHECK (length(notes) <= 1000),
  assigned_npc_id TEXT,
  lead_npc_id TEXT NOT NULL DEFAULT 'hal',
  status TEXT NOT NULL CHECK (status IN ('planned','in_progress','completed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Derive the active run by querying the partial index, not a cached mission field.
CREATE TABLE team_run_transitions (
  from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  PRIMARY KEY (from_state, to_state)
);
CREATE TABLE team_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued','planning','working','reviewing','revising',
    'awaiting_commander_review','paused','cancelling',
    'completed','cancelled','failed'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  round INTEGER NOT NULL DEFAULT 0 CHECK (round BETWEEN 0 AND 4),
  mode TEXT NOT NULL CHECK (mode IN ('mock','live')),
  paused_from TEXT,
  end_reason TEXT CHECK (end_reason IN (
    'approved','commander_rejected','commander_cancelled',
    'limit_reached','lead_unavailable','run_timeout','internal_error'
  )),
  unreviewed INTEGER NOT NULL DEFAULT 0 CHECK (unreviewed IN (0,1)),
  active_execution_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_execution_ms >= 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE (mission_id, client_request_id),
  UNIQUE (id, mission_id),
  CHECK ((state = 'paused') = (paused_from IS NOT NULL)),
  CHECK ((state IN ('completed','cancelled','failed')) = (completed_at IS NOT NULL)),
  CHECK (state NOT IN ('completed','cancelled','failed') OR end_reason IS NOT NULL)
);
CREATE UNIQUE INDEX one_active_team_run_per_mission ON team_runs(mission_id)
  WHERE state NOT IN ('completed','cancelled','failed');
CREATE TRIGGER team_runs_guard BEFORE UPDATE ON team_runs BEGIN
  SELECT RAISE(ABORT,'run version must advance by exactly 1')
    WHERE NEW.version <> OLD.version + 1;
  SELECT RAISE(ABORT,'terminal runs are immutable')
    WHERE OLD.state IN ('completed','cancelled','failed');
  SELECT RAISE(ABORT,'illegal run transition')
    WHERE NEW.state <> OLD.state AND NOT EXISTS (
      SELECT 1 FROM team_run_transitions
      WHERE from_state = OLD.state AND to_state = NEW.state
    );
  SELECT RAISE(ABORT,'resume must return to the paused-from state')
    WHERE OLD.state = 'paused' AND NEW.state NOT IN ('paused','cancelling','failed')
      AND NEW.state <> OLD.paused_from;
END;
CREATE TRIGGER team_runs_delete_only_with_mission BEFORE DELETE ON team_runs
  WHEN EXISTS (SELECT 1 FROM missions WHERE id = OLD.mission_id)
  BEGIN SELECT RAISE(ABORT,'runs are removed only with their mission'); END;
CREATE TRIGGER missions_no_delete_with_active_run BEFORE DELETE ON missions
  WHEN EXISTS (
    SELECT 1 FROM team_runs
    WHERE mission_id = OLD.id AND state NOT IN ('completed','cancelled','failed')
  )
  BEGIN SELECT RAISE(ABORT,'mission has an active team run'); END;

CREATE TABLE team_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
  npc_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  round INTEGER NOT NULL CHECK (round BETWEEN 0 AND 4),
  status TEXT NOT NULL CHECK (status IN (
    'pending','running','succeeded','failed','skipped','discarded'
  )),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (id, run_id), UNIQUE (run_id, position, round)
);
CREATE TABLE team_step_attempts (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES team_steps(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  state TEXT NOT NULL CHECK (state IN (
    'running','succeeded','failed','discarded'
  )),
  started_at TEXT NOT NULL, ended_at TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  UNIQUE (step_id, attempt_no)
);
CREATE UNIQUE INDEX one_running_attempt_per_step
  ON team_step_attempts(step_id) WHERE state = 'running';

CREATE TABLE team_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL, run_id TEXT NOT NULL,
  step_id TEXT,
  attempt_id TEXT REFERENCES team_step_attempts(id),
  parent_event_uuid TEXT REFERENCES team_events(event_uuid),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  round INTEGER NOT NULL CHECK (round BETWEEN 0 AND 4),
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'plan','delegation','contribution','review','revision_request',
    'synthesis','approval_request','commander_decision','status',
    'error','cancelled','paused','resumed','limit_reached','discarded'
  )),
  from_actor_json TEXT NOT NULL CHECK (json_valid(from_actor_json)),
  to_actors_json TEXT NOT NULL CHECK (json_valid(to_actors_json)),
  text TEXT NOT NULL CHECK (length(text) <= 6000),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  UNIQUE (run_id, sequence),
  FOREIGN KEY (run_id, mission_id)
    REFERENCES team_runs(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (step_id, run_id) REFERENCES team_steps(id, run_id)
);
CREATE INDEX team_events_by_run_cursor ON team_events(run_id, cursor);
CREATE TRIGGER team_events_no_update BEFORE UPDATE ON team_events
  BEGIN SELECT RAISE(ABORT,'team events are append-only'); END;
CREATE TRIGGER team_events_delete_only_with_mission BEFORE DELETE ON team_events
  WHEN EXISTS (SELECT 1 FROM missions WHERE id = OLD.mission_id)
  BEGIN SELECT RAISE(ABORT,'team events are removed only when their mission is deleted'); END;
CREATE TRIGGER team_events_parent_same_run BEFORE INSERT ON team_events
  WHEN NEW.parent_event_uuid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_events
    WHERE event_uuid = NEW.parent_event_uuid AND run_id = NEW.run_id
  )
  BEGIN SELECT RAISE(ABORT,'parent event must belong to the same run'); END;


-- Claude's PR #9 third-review additions: preserve migration receipts,
-- canonical participant membership and same-step attempt attribution.
CREATE TABLE mission_participants (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  npc_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  PRIMARY KEY (mission_id, npc_id),
  UNIQUE (mission_id, position)
);
CREATE TRIGGER mission_participants_not_lead BEFORE INSERT ON mission_participants
  WHEN EXISTS (
    SELECT 1 FROM missions WHERE id=NEW.mission_id AND lead_npc_id=NEW.npc_id
  )
  BEGIN SELECT RAISE(ABORT,'the lead cannot also be a participant'); END;
-- Also guard later edits: changing the lead or participant membership must
-- never bypass the initial insert rule.
CREATE TRIGGER mission_participants_not_lead_on_update
  BEFORE UPDATE OF npc_id,mission_id ON mission_participants
  WHEN EXISTS (
    SELECT 1 FROM missions WHERE id=NEW.mission_id AND lead_npc_id=NEW.npc_id
  )
  BEGIN SELECT RAISE(ABORT,'the lead cannot also be a participant'); END;
CREATE TRIGGER missions_lead_not_participant_on_update
  BEFORE UPDATE OF lead_npc_id ON missions
  WHEN EXISTS (
    SELECT 1 FROM mission_participants
    WHERE mission_id=NEW.id AND npc_id=NEW.lead_npc_id
  )
  BEGIN SELECT RAISE(ABORT,'the lead cannot also be a participant'); END;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  source_name TEXT, source_sha256 TEXT,
  backup_path TEXT, backup_sha256 TEXT,
  imported_count INTEGER CHECK (imported_count IS NULL OR imported_count >= 0),
  rejected_count INTEGER CHECK (rejected_count IS NULL OR rejected_count >= 0)
);
CREATE TABLE rejected_records (
  content_sha256 TEXT PRIMARY KEY,
  source_name TEXT NOT NULL, source_position INTEGER,
  reason TEXT NOT NULL, raw_json TEXT NOT NULL, rejected_at TEXT NOT NULL
);
CREATE TRIGGER team_events_attempt_matches_step BEFORE INSERT ON team_events
  WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_step_attempts
    WHERE id=NEW.attempt_id AND step_id IS NEW.step_id
  )
  BEGIN SELECT RAISE(ABORT,'attempt does not belong to the event step'); END;
