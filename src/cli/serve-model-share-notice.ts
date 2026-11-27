import type { ModelShareMode } from "../http/model-share-settings.js";
import { LOCAL_ONLY_HINT, RAW_MODEL_PREFIX } from "../http/route-raw-model.js";

/**
 * ATO-2336: what serve says at start about the shared model. Nothing when
 * sharing is off; where it is when on; and, when serve listens beyond
 * loopback, the warning that the traffic is plain http on the network.
 * The switch is read per request, so a later `models share` still works
 * without this line.
 *
 * ATO-2483: a serve beyond loopback while the mode is "this computer"
 * (`local`) refuses other devices on the raw routes. Up to v0.10.0 that
 * serve answered them, so it says so at start, with the command that lets
 * them in again.
 */
export function modelShareNotice(enabled: boolean, loopbackOnly: boolean, mode?: ModelShareMode): string {
  if (!enabled) return "";
  const where = `[atomic-agent] model share: the local model is on ${RAW_MODEL_PREFIX} for the share key (atomic-agent models share)\n`;
  if (loopbackOnly) return where;
  if (mode === "local") {
    return where + `[atomic-agent] note: serve listens on the network, but ${LOCAL_ONLY_HINT.toLowerCase()}\n`;
  }
  return (
    where +
    `[atomic-agent] warning: ${RAW_MODEL_PREFIX} is reachable from the local network over plain http; anyone on this network can read the traffic\n`
  );
}
