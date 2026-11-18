import { resolve } from "node:path";

/**
 * Whether a fusion worker gets its own workspace view (ATO-1601).
 *
 * A cloud worker always does: it inherits the parent's cloud workspace
 * (skills and project instructions of the session's folder).
 *
 * A local worker reads its skill catalog from the runtime's skill
 * registry, which was built for the folder the agent started in. That
 * is right while the session is still there; once the session moved to
 * another folder, the worker would list the old folder's project skills
 * and miss the new one's. Then it gets a local workspace view too:
 * `prepareWorkspace(session, cloud = false)` scans the worker's own
 * folder for skills, through the same project-trust gate, and loads no
 * project instruction files (those stay cloud-only, as before).
 */
export function workerInheritsWorkspace(input: {
  modelMode: string | undefined;
  /** The parent session's folder, where the worker runs. */
  sessionDir: string;
  /** The folder the runtime started in (the skill registry's project dir). */
  startupDir: string;
}): boolean {
  if (input.modelMode === "cloud") return true;
  return resolve(input.sessionDir) !== resolve(input.startupDir);
}
