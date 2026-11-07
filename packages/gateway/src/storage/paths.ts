import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DataPaths {
  dataDir: string;
  databasePath: string;
  backupDir: string;
  legacyJsonPath: string;
}

/** The repository's gitignored data/ folder (same depth from src/ and dist/). */
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../../../data/", import.meta.url));

/** GLC_DATA_DIR overrides the data folder; relative values resolve from the working directory. */
export function resolveDataPaths(env: NodeJS.ProcessEnv = process.env): DataPaths {
  const configured = env.GLC_DATA_DIR?.trim();
  const dataDir = configured
    ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured))
    : resolve(DEFAULT_DATA_DIR);
  return {
    dataDir,
    databasePath: join(dataDir, "headquarters.sqlite"),
    backupDir: join(dataDir, "backups"),
    legacyJsonPath: join(dataDir, "missions.json")
  };
}
