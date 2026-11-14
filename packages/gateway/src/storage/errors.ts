/** Base class so callers can tell storage failures from programming errors. */
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export type StorageErrorCode =
  | "unsafe_connection"        // a required PRAGMA is not in effect
  | "foreign_database"         // the file holds tables that this application did not create
  | "newer_database"           // created by a newer release; refusing to touch it
  | "damaged_database"         // marker or seed data missing or inconsistent
  | "legacy_unreadable"        // missions.json is damaged, empty, or has an unknown schema version
  | "backup_failed"            // the verified backup could not be written or did not verify
  | "migration_failed"         // the import did not verify; nothing was committed
  | "invalid_change"           // a mission edit breaks a rule (lead/participants)
  | "corrupt_row";             // a stored row no longer matches the contract

export function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || code.startsWith("SQLITE_BUSY_") || code.startsWith("SQLITE_LOCKED_"));
}
