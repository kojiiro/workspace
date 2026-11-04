import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { missionSchema, missionFileSchema } from "@glc/shared";
import type { CreateMissionRequest, Mission, UpdateMissionRequest } from "@glc/shared";

export const DEFAULT_MISSIONS_PATH = fileURLToPath(
  new URL("../../../data/missions.json", import.meta.url)
);

type RejectedRecord = { index: number; record: unknown; issues: string[] };

const transientWindowsRenameCodes = new Set(["EPERM", "EBUSY", "EACCES"]);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Single-user file storage. One serialized store instance should own its file. */
export class MissionStore {
  private missions: Mission[] | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly path = DEFAULT_MISSIONS_PATH) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async quarantine(rejected: RejectedRecord[]): Promise<void> {
    // Preserve the original invalid records BEFORE replacing the source on the
    // next successful save. Never overwrite an existing rejection sidecar.
    const primary = this.path.endsWith(".json")
      ? this.path.slice(0, -5) + ".rejected.json"
      : this.path + ".rejected.json";
    const payload = JSON.stringify({
      schemaVersion: 1, quarantinedAt: new Date().toISOString(), rejected
    }, null, 2) + "\n";
    await mkdir(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejectedPath = attempt === 0 ? primary
        : primary.replace(/\.json$/, "." + randomUUID() + ".json");
      try {
        const file = await open(rejectedPath, "wx", 0o600);
        try {
          await file.writeFile(payload, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        console.warn("[MissionStore] quarantined " + rejected.length
          + " invalid record(s) in " + rejectedPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 1) throw error;
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.missions !== null) return;
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.missions = [];
        return;
      }
      throw error;
    }

    // Syntax and envelope errors fail closed: the original file is never
    // modified, and a subsequent request can retry after manual repair.
    const parsed: unknown = JSON.parse(content);
    let records: unknown[];
    if (Array.isArray(parsed)) {
      // v0.3 legacy bare-array file. Rewrite only on the next successful save.
      records = parsed;
    } else {
      records = missionFileSchema.parse(parsed).missions;
    }
    const valid: Mission[] = [];
    const rejected: RejectedRecord[] = [];
    const ids = new Set<string>();
    for (const [index, record] of records.entries()) {
      const checked = missionSchema.safeParse(record);
      if (!checked.success) {
        rejected.push({
          index, record,
          issues: checked.error.issues.map(issue => issue.path.join(".") + ": " + issue.message)
        });
      } else if (ids.has(checked.data.id)) {
        rejected.push({ index, record, issues: ["id: duplicate mission ID"] });
      } else {
        valid.push(checked.data);
        ids.add(checked.data.id);
      }
    }

    if (rejected.length) await this.quarantine(rejected);
    // Do not cache before quarantine succeeds, or invalid records could be lost.
    this.missions = valid;
  }

  private async persist(next: Mission[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ schemaVersion: 1, missions: next }, null, 2) + "\n", "utf8"
        );
        // Fsync the temp file before the atomic replacement for durability.
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await rename(temporary, this.path);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!code || !transientWindowsRenameCodes.has(code) || attempt === 2) throw error;
          await delay(80 * (attempt + 1));
        }
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    // Only update cache after file replacement succeeds.
    this.missions = next;
  }

  async list(): Promise<Mission[]> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      return [...this.missions!].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(mission => ({ ...mission }));
    });
  }

  async create(input: CreateMissionRequest): Promise<Mission> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const now = new Date().toISOString();
      const mission: Mission = {
        id: randomUUID(), title: input.title, notes: input.notes,
        assignedNpcId: input.assignedNpcId, status: "planned",
        createdAt: now, updatedAt: now
      };
      await this.persist([...this.missions!, mission]);
      return { ...mission };
    });
  }

  async update(id: string, input: UpdateMissionRequest): Promise<Mission | null> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const index = this.missions!.findIndex(mission => mission.id === id);
      if (index < 0) return null;
      const changed: Mission = { ...this.missions![index], ...input, updatedAt: new Date().toISOString() };
      const next = [...this.missions!];
      next[index] = changed;
      await this.persist(next);
      return { ...changed };
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const next = this.missions!.filter(mission => mission.id !== id);
      if (next.length === this.missions!.length) return false;
      await this.persist(next);
      return true;
    });
  }
}
