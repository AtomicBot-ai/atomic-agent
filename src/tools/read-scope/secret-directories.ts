import { resolve } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";
import { canonical } from "./read-scope.js";

/**
 * ATO-2496: the sign-in folder `path` lies in (or is), or `null`. Both
 * spellings of each side are compared, so a symlinked state directory
 * (`/tmp` vs `/private/tmp`) or a symlink into the folder is caught.
 * `isInside` compares case-insensitively on Windows, as the filesystem does.
 */
export function secretDirectoryHolding(
  path: string,
  directories: readonly string[],
): string | null {
  if (directories.length === 0) return null;
  const real = canonical(path);
  for (const entry of directories) {
    const lexical = resolve(entry);
    for (const dir of [lexical, canonical(lexical)]) {
      if (isInside(dir, path) || isInside(dir, real)) return entry;
    }
  }
  return null;
}
