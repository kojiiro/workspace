import { createHash } from "node:crypto";
import { missionFileSchema, missionSchema } from "@glc/shared";
import type { z } from "zod";
import { StorageError } from "./errors.js";

/** A v1 mission as stored in data/missions.json (before leads, participants and revisions). */
export type LegacyMission = z.infer<typeof missionSchema>;

export interface RejectedLegacyRecord {
  position: number;
  reason: string;
  rawJson: string;
  contentSha256: string;
}

export interface ParsedLegacyFile {
  kind: "bare-array" | "envelope-v1";
  records: unknown[];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Parses the legacy file. Anything that is not a recognised v1 shape throws:
 * damaged, empty, or newer-than-known data must never be mistaken for "no missions".
 * A UTF-8 byte-order mark (added by some Windows editors and PowerShell) is tolerated.
 */
export function parseLegacyMissionFile(content: Buffer): ParsedLegacyFile {
  let text = content.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StorageError("legacy_unreadable",
      "data/missions.json is empty or is not valid JSON. It was not changed. Repair or move it aside, or restore a backup from data/backups.",
      { cause: error });
  }
  if (Array.isArray(parsed)) return { kind: "bare-array", records: parsed };
  const envelope = missionFileSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new StorageError("legacy_unreadable",
      "data/missions.json has an unknown layout or schema version. It was not changed. Update the application or restore a backup from data/backups.",
      { cause: envelope.error });
  }
  return { kind: "envelope-v1", records: envelope.data.missions };
}

/** Splits records into importable missions and rejected ones; duplicate IDs keep the first copy. */
export function validateLegacyRecords(records: unknown[]): { valid: LegacyMission[]; rejected: RejectedLegacyRecord[] } {
  const valid: LegacyMission[] = [];
  const rejected: RejectedLegacyRecord[] = [];
  const seen = new Set<string>();
  const reject = (position: number, record: unknown, reason: string) => {
    const rawJson = JSON.stringify(record) ?? "null";
    rejected.push({ position, reason, rawJson, contentSha256: sha256Hex(rawJson) });
  };
  for (const [position, record] of records.entries()) {
    const checked = missionSchema.safeParse(record);
    if (!checked.success) {
      reject(position, record,
        checked.error.issues.map(issue => `${issue.path.join(".") || "(record)"}: ${issue.message}`).join("; ").slice(0, 500));
    } else if (seen.has(checked.data.id)) {
      reject(position, record, "id: duplicate mission ID");
    } else {
      seen.add(checked.data.id);
      valid.push(checked.data);
    }
  }
  return { valid, rejected };
}
