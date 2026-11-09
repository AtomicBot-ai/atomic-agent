/**
 * ATO-1045 — the terminal's no-key path, second half.
 *
 * The first-run picker offers the starter model first (`quickStart` in
 * local-model-picks.ts): 1.3 GB, the agent answers within a minute of the
 * download. When it lands, this starts the best model for this machine as
 * a background download (`startModelUpgrade`, ATO-1043: GPU memory and
 * free disk in view). The orchestrator adopts that job like any
 * `models pull --background`: progress in the top bar, and when it lands
 * it becomes the active model the way every finished pull in the TUI does.
 *
 * Any landing of the starter counts, not only the first-run row: the
 * starter has no other purpose. The decision itself leaves alone a cloud
 * route, an external server and a model the person added.
 */

import { STARTER_LOCAL_MODEL_ID, type LocalModelDef } from "../../local-llm/index.js";
import { startModelUpgrade, type StartedUpgrade } from "../../local-llm/model-upgrade-runner.js";

export interface StarterUpgradeDeps {
  start?: () => Promise<StartedUpgrade>;
}

/**
 * Start the upgrade after `landed` became the active model. Answers the
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
    started = await (deps.start ?? (() => startModelUpgrade()))();
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
  if (d.action === "download" && started.job) {
    return (
      `local-llm: getting ${d.model.name} (${d.model.sizeLabel}) in the background, the best model for this machine. ` +
      `Chats run on ${starterName} until it lands, then it takes over.`
    );
  }
  if (d.action === "switch") {
    return `local-llm: ${d.model.name} is already on disk, the best model for this machine. Pick it in /models to switch.`;
  }
  return null;
}
