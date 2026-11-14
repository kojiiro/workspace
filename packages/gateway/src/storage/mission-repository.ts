import { randomUUID } from "node:crypto";
import {
  DEFAULT_MISSION_LEAD_NPC_ID, DEFAULT_MISSION_PARTICIPANT_NPC_IDS,
  TEAM_RUN_TERMINAL_STATES, teamMissionRecordSchema
} from "@glc/shared";
import type { Mission, MissionStatus } from "@glc/shared";
import type { Db } from "./database.js";
import { StorageError } from "./errors.js";

export interface CreateMissionInput {
  title: string;
  notes: string;
  assignedNpcId: string | null;
  leadNpcId?: string;
  participantNpcIds?: string[];
}

export interface MissionChanges {
  title?: string;
  notes?: string;
  assignedNpcId?: string | null;
  status?: MissionStatus;
  leadNpcId?: string;
  participantNpcIds?: string[];
}

export type UpdateOutcome =
  | { ok: true; mission: Mission; changed: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "stale_revision"; current: Mission };

export type DeleteOutcome =
  | { ok: true; removed: { runs: number; events: number } }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "stale_revision"; current: Mission }
  | { ok: false; reason: "active_run"; current: Mission };

/**
 * Mission persistence. Mission `revision` covers mission content only (title, notes,
 * assignment, status, lead, participants); team-run progress has its own version.
 */
export interface MissionRepository {
  list(): Promise<Mission[]>;
  get(id: string): Promise<Mission | null>;
  create(input: CreateMissionInput): Promise<Mission>;
  update(id: string, expectedRevision: number, changes: MissionChanges): Promise<UpdateOutcome>;
  delete(id: string, expectedRevision: number): Promise<DeleteOutcome>;
  /** How much history a confirmed deletion would remove; null when the mission does not exist. */
  historyCounts(id: string): Promise<{ runs: number; events: number } | null>;
  close(): void;
}

interface MissionRow {
  id: string; title: string; notes: string; assigned_npc_id: string | null;
  lead_npc_id: string; status: string; revision: number; created_at: string; updated_at: string;
}
interface ParticipantRow { mission_id: string; npc_id: string }

const terminalPlaceholders = TEAM_RUN_TERMINAL_STATES.map(() => "?").join(", ");

function assertTeamShape(lead: string, participants: readonly string[]): void {
  if (participants.length < 1 || participants.length > 4) {
    throw new StorageError("invalid_change", "A mission needs between 1 and 4 participants.");
  }
  if (new Set(participants).size !== participants.length) {
    throw new StorageError("invalid_change", "A participant is listed twice.");
  }
  if (participants.includes(lead)) {
    throw new StorageError("invalid_change", "The mission lead cannot also be a participant.");
  }
}

export class SqliteMissionRepository implements MissionRepository {
  constructor(private readonly db: Db) {}

  private map(row: MissionRow, participants: string[]): Mission {
    const candidate = {
      id: row.id, title: row.title, notes: row.notes, assignedNpcId: row.assigned_npc_id,
      leadNpcId: row.lead_npc_id, participantNpcIds: participants,
      status: row.status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
    };
    const checked = teamMissionRecordSchema.safeParse(candidate);
    if (!checked.success) {
      throw new StorageError("corrupt_row", `Stored mission ${row.id} does not match the mission contract.`,
        { cause: checked.error });
    }
    return checked.data;
  }

  private participantsOf(id: string): string[] {
    return (this.db.prepare(
      "SELECT npc_id FROM mission_participants WHERE mission_id = ? ORDER BY position"
    ).all(id) as Array<{ npc_id: string }>).map(row => row.npc_id);
  }

  private getSync(id: string): Mission | null {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as MissionRow | undefined;
    return row ? this.map(row, this.participantsOf(id)) : null;
  }

  private insertParticipants(missionId: string, participants: readonly string[]): void {
    const insert = this.db.prepare(
      "INSERT INTO mission_participants (mission_id, npc_id, position) VALUES (?, ?, ?)");
    participants.forEach((npcId, position) => insert.run(missionId, npcId, position));
  }

  private hasActiveRun(id: string): boolean {
    return this.db.prepare(
      `SELECT 1 FROM team_runs WHERE mission_id = ? AND state NOT IN (${terminalPlaceholders}) LIMIT 1`
    ).get(id, ...TEAM_RUN_TERMINAL_STATES) !== undefined;
  }

  async list(): Promise<Mission[]> {
    const rows = this.db.prepare("SELECT * FROM missions ORDER BY updated_at DESC, id").all() as MissionRow[];
    const byMission = new Map<string, string[]>();
    for (const row of this.db.prepare(
      "SELECT mission_id, npc_id FROM mission_participants ORDER BY mission_id, position"
    ).all() as ParticipantRow[]) {
      const list = byMission.get(row.mission_id) ?? [];
      list.push(row.npc_id);
      byMission.set(row.mission_id, list);
    }
    return rows.map(row => this.map(row, byMission.get(row.id) ?? []));
  }

  async get(id: string): Promise<Mission | null> {
    return this.getSync(id);
  }

  async create(input: CreateMissionInput): Promise<Mission> {
    const lead = input.leadNpcId ?? DEFAULT_MISSION_LEAD_NPC_ID;
    const participants = input.participantNpcIds ?? [...DEFAULT_MISSION_PARTICIPANT_NPC_IDS];
    assertTeamShape(lead, participants);
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO missions (id, title, notes, assigned_npc_id, lead_npc_id, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'planned', 1, ?, ?)`
      ).run(id, input.title, input.notes, input.assignedNpcId, lead, now, now);
      this.insertParticipants(id, participants);
      return this.getSync(id)!;
    }).immediate();
  }

  async update(id: string, expectedRevision: number, changes: MissionChanges): Promise<UpdateOutcome> {
    return this.db.transaction((): UpdateOutcome => {
      const current = this.getSync(id);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.revision !== expectedRevision) return { ok: false, reason: "stale_revision", current };

      const next = {
        title: changes.title ?? current.title,
        notes: changes.notes ?? current.notes,
        assignedNpcId: changes.assignedNpcId === undefined ? current.assignedNpcId : changes.assignedNpcId,
        status: changes.status ?? current.status,
        leadNpcId: changes.leadNpcId ?? current.leadNpcId,
        participantNpcIds: changes.participantNpcIds ?? current.participantNpcIds
      };
      assertTeamShape(next.leadNpcId, next.participantNpcIds);

      const participantsChanged = next.participantNpcIds.length !== current.participantNpcIds.length
        || next.participantNpcIds.some((npcId, index) => npcId !== current.participantNpcIds[index]);
      const unchanged = !participantsChanged && next.title === current.title && next.notes === current.notes
        && next.assignedNpcId === current.assignedNpcId && next.status === current.status
        && next.leadNpcId === current.leadNpcId;
      if (unchanged) return { ok: true, mission: current, changed: false };

      // Replace the whole participant list first so a lead change never meets a stale row.
      if (participantsChanged) this.db.prepare("DELETE FROM mission_participants WHERE mission_id = ?").run(id);
      const updated = this.db.prepare(
        `UPDATE missions SET title = ?, notes = ?, assigned_npc_id = ?, lead_npc_id = ?, status = ?,
           revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`
      ).run(next.title, next.notes, next.assignedNpcId, next.leadNpcId, next.status,
        new Date().toISOString(), id, expectedRevision);
      if (updated.changes !== 1) {
        // Cannot happen inside an IMMEDIATE transaction; fail safe rather than guess.
        throw new StorageError("migration_failed", "Mission revision check failed unexpectedly.");
      }
      if (participantsChanged) this.insertParticipants(id, next.participantNpcIds);
      return { ok: true, mission: this.getSync(id)!, changed: true };
    }).immediate();
  }

  async delete(id: string, expectedRevision: number): Promise<DeleteOutcome> {
    return this.db.transaction((): DeleteOutcome => {
      const current = this.getSync(id);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.revision !== expectedRevision) return { ok: false, reason: "stale_revision", current };
      if (this.hasActiveRun(id)) return { ok: false, reason: "active_run", current };

      const counts = this.countHistory(id);
      const removed = this.db.prepare("DELETE FROM missions WHERE id = ? AND revision = ?").run(id, expectedRevision);
      if (removed.changes !== 1) throw new StorageError("migration_failed", "Mission delete did not apply.");
      // Belt and braces: the cascade must have removed this mission's history, and only its history.
      if (this.countHistory(id).runs !== 0) throw new StorageError("migration_failed", "History was not removed with the mission.");
      return { ok: true, removed: counts };
    }).immediate();
  }

  private countHistory(id: string): { runs: number; events: number } {
    const runs = (this.db.prepare("SELECT count(*) AS c FROM team_runs WHERE mission_id = ?").get(id) as { c: number }).c;
    const events = (this.db.prepare("SELECT count(*) AS c FROM team_events WHERE mission_id = ?").get(id) as { c: number }).c;
    return { runs, events };
  }

  async historyCounts(id: string): Promise<{ runs: number; events: number } | null> {
    return this.getSync(id) ? this.countHistory(id) : null;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
