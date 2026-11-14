import { applySchemaInTransaction, openDatabase, SCHEMA_VERSION } from "./database.js";
import { SqliteMissionRepository } from "./mission-repository.js";

/**
 * A throwaway repository for tests and tools that must not touch the data folder.
 * The real gateway (server.ts) always passes a file-backed repository.
 */
export function createInMemoryMissionRepository(): SqliteMissionRepository {
  const db = openDatabase({ path: ":memory:" });
  db.transaction(() => {
    applySchemaInTransaction(db);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at, imported_count, rejected_count) VALUES (?, ?, 0, 0)"
    ).run(SCHEMA_VERSION, new Date().toISOString());
  }).immediate();
  return new SqliteMissionRepository(db);
}
