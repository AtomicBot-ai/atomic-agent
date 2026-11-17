/**
 * ATO-1045 — the terminal's no-key path, second half.
 *
 * The first-run picker offers the starter model first (`quickStart` in
 * local-model-picks.ts): 1.3 GB, the agent answers within a minute of the
 * download. When it lands, this names the best model for this machine
 * (`startModelUpgrade` in dry-run, ATO-1043: GPU memory and free disk in
 * view) with its size and the command that gets it. ATO-1475: nothing is
 * downloaded without the person asking, a multi-GB pull is their call.
 * The line is said once, when the starter lands, so it never nags.
 *
 * Any landing of the starter counts, not only the first-run row: the
 * starter has no other purpose. The decision itself leaves alone a cloud
 * route, an external server and a model the person added.
 */

import { STARTER_LOCAL_MODEL_ID, type LocalModelDef } from "../../local-llm/index.js";
import { startModelUpgrade, type StartedUpgrade } from "../../local-llm/model-upgrade-runner.js";

export interface StarterUpgradeDeps {
  /** Decides only: the default runs `startModelUpgrade` with `dryRun`. */
  start?: () => Promise<StartedUpgrade>;
}

/**
 * Suggest the upgrade after `landed` became the active model. Answers the
 * line for the transcript, or null when there is nothing to say (not the
 * starter, nothing better, or the probe failed: never a reason to break
 * the landing that called it).
 */
export async function upgradeAfterStarter(
  landed: Pick<LocalModelDef, "id" | "name">,
  deps: StarterUpgradeDeps = {},
): Promise<string | null> {
  if (landed.id !== STARTER_LOCAL_MODEL_ID) return null;
  let started: StartedUpgrade;
  try {
    started = await (deps.start ?? (() => startModelUpgrade({ dryRun: true })))();
  } catch {
    return null;
  }
  return describeStarterUpgrade(started, landed.name);
}

export function describeStarterUpgrade(
  started: StartedUpgrade,
  starterName: string,
): string | null {
  const d = started.snapshot.decision;
  if (d.action === "download") {
    return (
      `local-llm: ${d.model.name} is the best model for this machine, a ${d.model.sizeLabel} download. ` +
      `Nothing downloads unless you ask: /models pull ${d.model.id} gets it. Chats keep running on ${starterName}.`
    );
  }
  if (d.action === "switch") {
    return `local-llm: ${d.model.name} is already on disk, the best model for this machine. Pick it in /models to switch.`;
  }
  return null;
}
