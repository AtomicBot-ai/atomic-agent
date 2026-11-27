import { assertNoModelsDirMove } from "./models-dir-move-lock.js";
import { modelsDirUnreachableMessage, unreachableModelsDir } from "./models-dir-override.js";

/**
 * The checks a model start or a download makes on the models folder
 * before touching it (ATO-2503): no move under way in another process,
 * and the folder's disk is connected. Without the second, a pull to an
 * unplugged external disk created an empty folder tree where its mount
 * point was (or failed with a bare ENOENT), and a start said "not
 * downloaded; run models pull" about a model that sits on that disk.
 */
export class ModelsDirUnreachableError extends Error {
  constructor(readonly dir: string) {
    super(modelsDirUnreachableMessage(dir));
    this.name = "ModelsDirUnreachableError";
  }
}

/** Throw when a move runs elsewhere or the models folder is not there. */
export function assertModelsDirUsable(dataDir: string): void {
  assertNoModelsDirMove(dataDir);
  const dir = unreachableModelsDir();
  if (dir !== null) throw new ModelsDirUnreachableError(dir);
}

/**
 * The error for a managed model file that is missing: the disk one when
 * the models folder is not there, else `fallback` ("not downloaded; run
 * models pull").
 */
export function missingModelError(fallback: string): Error {
  const dir = unreachableModelsDir();
  return dir !== null ? new ModelsDirUnreachableError(dir) : new Error(fallback);
}
