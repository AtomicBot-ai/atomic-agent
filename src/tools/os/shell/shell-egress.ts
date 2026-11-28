import { basename, resolve, sep } from "node:path";
import {
  scanEgress,
  withUnreadableScript,
  type EgressDestination,
} from "../../../approval/egress-scan.js";
import { gitRemoteUrls } from "../../../approval/git-remote-url.js";
import { publishRegistryUrl } from "../../../approval/publish-registry.js";
import { registryVariableSet } from "../../../approval/registry-variables.js";

export interface ShellEgressFacts {
  /**
   * The call feeds a script to a shell or interpreter (`printf … | sh`,
   * `shellRunsUnreadableScript`): what runs cannot be read, so it counts
   * as sending data to a host nobody knows (`UNREADABLE_SCRIPT_EGRESS`).
   */
  commandUnreadable?: boolean;
  /** The files the call writes (`shellWriteTargets`), absolute. */
  targetPaths?: readonly string[];
  /** The environment the command inherits; a test seam. */
  env?: NodeJS.ProcessEnv;
}

/**
 * A write into a `.git` folder or a git config file can change where a
 * push goes: `~/.gitconfig`, the XDG `~/.config/git/config` (review
 * round 3 of ATO-2528), a system `gitconfig`, `.gitmodules`.
 */
function writesGitState(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const name = basename(path).toLowerCase();
    const lower = path.toLowerCase();
    return (
      name === ".git" ||
      name === ".gitconfig" ||
      name === "gitconfig" ||
      name === ".gitmodules" ||
      lower.includes(`${sep}.git${sep}`) ||
      lower.endsWith(`${sep}git${sep}config`)
    );
  });
}

/**
 * Where a shell call sends data (ATO-2116), for the approval card, the
 * risk reviewer and the gate's egress hold. A `git push` to a remote name
 * is read from the repository the command runs in (`cwd`, or its `-C`
 * folder) without running git, unless the call itself writes git state.
 */
export function shellEgress(
  commandSegments: readonly (readonly string[])[],
  cwd: string,
  facts: ShellEgressFacts = {},
): EgressDestination[] {
  const found = scanEgress(commandSegments, {
    gitRemote: (remote, chdir) =>
      gitRemoteUrls(chdir === undefined ? cwd : resolve(cwd, chdir), remote),
    gitStateWritten: writesGitState(facts.targetPaths ?? []),
    // The registry a publish goes to, from `.npmrc` / cargo config (ATO-2528),
    // unless the agent's own environment sets it (review round 2).
    publishRegistry: (program, name) =>
      registryVariableSet(facts.env ?? process.env) ? null : publishRegistryUrl(cwd, program, name),
    httpConfigWritten: (facts.targetPaths ?? []).some((path) =>
      [".curlrc", "_curlrc", ".wgetrc"].includes(basename(path).toLowerCase()),
    ),
  });
  return withUnreadableScript(found, facts.commandUnreadable === true);
}
