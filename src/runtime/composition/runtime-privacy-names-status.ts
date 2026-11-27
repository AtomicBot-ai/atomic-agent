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
 * Provider kinds that do not go through the OpenAI-compatible adapter,
 * where Privacy Shield lives (`openai-privacy-shield.ts`): they send the
 * text as it is.
 */
const UNSHIELDED_KINDS: ReadonlySet<string> = new Set(["subscription-oauth", "subscription-cli"]);

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
 *  - `provider-not-shielded`: on, but the active chat provider is a
 *    ChatGPT sign-in or a vendor CLI (Claude Code, Codex). Privacy
 *    Shield does not wrap those, so nothing is masked for them; the
 *    status must not promise it.
 */
export function privacyNamesStatus(config: AtomicAgentConfig = getConfig()): PrivacyNamesStatus {
  const enabled = config.privacy?.shield.localNames === true;
  const llm = resolveLlmConfig(config);
  const entry = pickLocalNameEntry(llm, config.localModels.url);
  const model =
    entry === undefined ? null : { provider: entry.id, model: entry.model ?? entry.defaultChatModel ?? null };
  if (!enabled) return { enabled, state: "off", model };
  const active = llm.providers.find((p) => p.id === llm.activeTextProvider);
  if (active !== undefined && UNSHIELDED_KINDS.has(active.kind)) {
    return { enabled, state: "provider-not-shielded", model };
  }
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
