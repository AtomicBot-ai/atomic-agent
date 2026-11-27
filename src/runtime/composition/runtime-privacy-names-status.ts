import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
  type AtomicAgentConfig,
} from "../../config/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import type { PrivacyNamesStatus } from "../runtime-contract.js";
import { pickLocalNameEntry } from "./runtime-privacy-names.js";

/**
 * What the Privacy tab says about names, addresses and organisations
 * (ATO-2527): whether `privacy.shield.localNames` is on and which local
 * model would read the text. Read from config each time, the same
 * choice `installPrivacyNameDetector` makes per request, so the tab never
 * names a model the pass would not use.
 *
 *  - `off`: the switch is off; only the regex masks apply.
 *  - `ready`: on, and a model on this machine is configured. If that
 *    model is not running when a request goes out, the request still
 *    goes out with the regex masks only (the pass fails to the floor).
 *  - `no-local-model`: on, but no provider runs on this machine
 *    (loopback only); only the regex masks apply.
 */
export function privacyNamesStatus(config: AtomicAgentConfig = getConfig()): PrivacyNamesStatus {
  const enabled = config.privacy?.shield.localNames === true;
  const entry = pickLocalNameEntry(resolveLlmConfig(config), config.localModels.url);
  const model =
    entry === undefined ? null : { provider: entry.id, model: entry.model ?? entry.defaultChatModel ?? null };
  if (!enabled) return { enabled, state: "off", model };
  return { enabled, state: model === null ? "no-local-model" : "ready", model };
}

/** Persist `privacy.shield.localNames`: read, merge, validate, write, reset. */
export function persistPrivacyLocalNames(localNames: boolean): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    privacy: { ...prev.privacy, shield: { ...prev.privacy?.shield, localNames } },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}
