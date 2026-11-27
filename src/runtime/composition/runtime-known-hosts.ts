import type { ApprovalGate } from "../../approval/approval-gate.js";
import { getConfig, parseUserConfigFile, resetConfigCache } from "../../config/index.js";
import {
  readConfigPath,
  readRawConfigTree,
  writeConfigPath,
  writeRawUserConfigFileSync,
} from "../../config/config-paths.js";
import { MAX_KNOWN_HOSTS, normaliseKnownHostEntry } from "../../config/agent/security-config.js";

const KEY = "agent.security.knownHosts";

/**
 * Durable known hosts for the egress hold (ATO-2528). The gate reads
 * `agent.security.knownHosts` live; "allow always" on a call that sends
 * data adds its hosts to the user config file, the way Claude Code's
 * "don't ask again for this domain" writes `WebFetch(domain:...)` into
 * its settings and ssh appends to `known_hosts`. A point edit like
 * `config set`: only this key changes on disk, and the whole file is
 * parsed before it is written, so a bad entry never lands there.
 */
export function addKnownHosts(configFile: string, hosts: readonly string[]): string[] {
  const tree = readRawConfigTree(configFile);
  const before = parseUserConfigFile(tree).agent.security?.knownHosts ?? [];
  const kept = [...before];
  for (const raw of hosts) {
    const entry = normaliseKnownHostEntry(raw);
    if (entry !== null && !kept.includes(entry) && kept.length < MAX_KNOWN_HOSTS) kept.push(entry);
  }
  if (kept.length === before.length) return kept;
  writeConfigPath(tree, KEY, kept);
  const next = parseUserConfigFile(tree);
  writeConfigPath(tree, KEY, readConfigPath(next, KEY));
  writeRawUserConfigFileSync(configFile, tree);
  resetConfigCache();
  return kept;
}

export function installKnownHosts(approvals: ApprovalGate): void {
  approvals.setEgressKnownHosts(
    () => getConfig().agent.security?.knownHosts ?? [],
    (hosts) => {
      addKnownHosts(getConfig().paths.userConfigFile, hosts);
    },
  );
}
