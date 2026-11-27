import { resolve } from "node:path";
import { scanEgress, type EgressDestination } from "../../../approval/egress-scan.js";
import { gitRemoteUrl } from "../../../approval/git-remote-url.js";

/**
 * Where a shell call sends data (ATO-2116), for the approval card, the
 * risk reviewer and the gate's egress hold. A `git push` to a remote name
 * is read from the repository the command runs in (`cwd`, or its `-C`
 * folder) without running git.
 */
export function shellEgress(
  commandSegments: readonly (readonly string[])[],
  cwd: string,
): EgressDestination[] {
  return scanEgress(commandSegments, {
    gitRemote: (remote, chdir) =>
      gitRemoteUrl(chdir === undefined ? cwd : resolve(cwd, chdir), remote),
  });
}
