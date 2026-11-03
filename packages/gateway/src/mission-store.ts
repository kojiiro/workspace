import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateMissionRequest, Mission, UpdateMissionRequest } from "@glc/shared";

export const DEFAULT_MISSIONS_PATH = fileURLToPath(
  new URL("../../../data/missions.json", import.meta.url)
);

/**
 * Minimal persistent mission store for the localhost prototype.
 * A serialized queue and atomic file replacement prevent concurrent writes
 * from losing changes. Future SQLite migration can preserve the API.
 */
export class MissionStore {
  private missions: Mission[] | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly path = DEFAULT_MISSIONS_PATH) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.missions !== null) return;
    try {
      const content = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) throw new Error("Mission storage is not an array");
      this.missions = parsed as Mission[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.missions = [];
      } else {
        throw error;
      }
    }
  }

  private async persist(next: Mission[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
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
        id: randomUUID(),
        title: input.title,
        notes: input.notes,
        assignedNpcId: input.assignedNpcId,
        status: "planned",
        createdAt: now,
        updatedAt: now
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
      const changed: Mission = {
        ...this.missions![index],
        ...input,
        updatedAt: new Date().toISOString()
      };
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
