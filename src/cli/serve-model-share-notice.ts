import { RAW_MODEL_PREFIX } from "../http/route-raw-model.js";

/**
 * ATO-2336: what serve says at start about the shared model. Nothing when
 * sharing is off; where it is when on; and, when serve listens beyond
 * loopback, the warning that the traffic is plain http on the network.
 * The switch is read per request, so a later `models share` still works
 * without this line.
 */
export function modelShareNotice(enabled: boolean, loopbackOnly: boolean): string {
  if (!enabled) return "";
  const where = `[atomic-agent] model share: the local model is on ${RAW_MODEL_PREFIX} for the share key (atomic-agent models share)\n`;
  if (loopbackOnly) return where;
  return (
    where +
    `[atomic-agent] warning: ${RAW_MODEL_PREFIX} is reachable from the local network over plain http; anyone on this network can read the traffic\n`
  );
}
