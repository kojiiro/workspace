import { createGateway } from "./app.js";
import { initializeStorage, resolveDataPaths, StorageError } from "./storage/index.js";
import type { StorageHandle } from "./storage/index.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 3001);
const paths = resolveDataPaths();

// The mission database is opened (and any legacy missions.json imported) BEFORE the
// gateway accepts requests. If that fails we stop with a clear message instead of
// serving an empty board over data that is still safe on disk.
let storage: StorageHandle;
try {
  storage = await initializeStorage({
    databasePath: paths.databasePath,
    legacyJsonPath: paths.legacyJsonPath,
    backupDir: paths.backupDir,
    log: { info: message => console.log(message), warn: message => console.warn(message) }
  });
} catch (error) {
  console.error("\nGLC gateway cannot start: the mission database could not be opened safely.");
  console.error((error as Error).message);
  if (!(error instanceof StorageError)) console.error(error);
  console.error("Your existing files in " + paths.dataDir + " were not deleted.");
  process.exit(1);
}

const app = createGateway(undefined, { logger: true, missionRepository: storage.repository });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} received; closing the gateway and the mission database.`);
  try {
    await app.close();
  } finally {
    storage.close();   // checkpoints the WAL and releases data/headquarters.sqlite
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

app.listen({ host, port }).then(() => {
  console.log("GLC gateway listening at http://" + host + ":" + port + " (mock only)");
  console.log("Mission database: " + paths.databasePath);
}).catch(error => {
  app.log.error(error);
  storage.close();
  process.exit(1);
});
