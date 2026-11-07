// Child process for the crash test. NOT a test file (no .test suffix): the parent test
// spawns it, and it kills itself with SIGKILL inside the import transaction, just
// before COMMIT, to prove a hard crash leaves the old data and the database clean.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeStorage } from "./storage/index.js";

const dir = process.argv[2];
await initializeStorage({
  databasePath: join(dir, "headquarters.sqlite"),
  legacyJsonPath: join(dir, "missions.json"),
  backupDir: join(dir, "backups"),
  hooks: {
    beforeCommit() {
      writeFileSync(join(dir, "reached-before-commit.flag"), "1");
      process.kill(process.pid, "SIGKILL");
      // Windows ignores signal names but still terminates the process; guard anyway.
      process.exit(137);
    }
  }
});
