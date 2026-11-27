import type Database from "better-sqlite3";

/**
 * Loads a vector extension into the index connection; answers whether it
 * is there. Never throws: a missing package or a failed load is `false`.
 */
export type VecExtensionLoader = (db: Database.Database) => Promise<boolean>;

/**
 * `sqlite-vec` is not a runtime dependency (ATO-1052): it is used when the
 * package happens to be installed next to the agent, and the index scans
 * vectors itself otherwise. It is a devDependency (ATO-1658) so tests and
 * CI cover the vec0 path; the SEA bundle keeps it external. The specifier
 * sits in a variable so neither `tsc` nor the import checker treats it as
 * a required module.
 */
const SQLITE_VEC_PACKAGE = "sqlite-vec";

interface SqliteVecModule {
  load?: (db: Database.Database) => void;
  default?: { load?: (db: Database.Database) => void };
}

export const loadSqliteVec: VecExtensionLoader = async (db) => {
  try {
    const mod = (await import(SQLITE_VEC_PACKAGE)) as SqliteVecModule;
    const load = mod.load ?? mod.default?.load;
    if (typeof load !== "function") return false;
    load(db);
    db.prepare("SELECT vec_version() AS v").get();
    return true;
  } catch {
    return false;
  }
};
