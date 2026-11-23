import { LOCAL_PROVIDER_KIND } from "../config/index.js";
import type { ResolvedLlmConfig } from "../llm/provider/index.js";
import { isLocalProviderUrl } from "../llm/provider/presets/is-local-provider-url.js";

/**
 * Whether a link is a cloud provider (`AgentLoopDependencies.isCloudLink`,
 * ATO-1578): an entry that is not a `llama-server` and whose address is
 * not this machine. LM Studio and Ollama on localhost read as local, a
 * subscription CLI or any remote API as cloud. `undefined` means the
 * active text provider; an id with no entry is not cloud, so an unknown
 * link keeps the plain "Retry".
 */
export function isCloudLink(
  providerId: string | undefined,
  llm: Pick<ResolvedLlmConfig, "activeTextProvider" | "providers">,
): boolean {
  const id = providerId ?? llm.activeTextProvider;
  const entry = llm.providers.find((provider) => provider.id === id);
  if (entry === undefined) return false;
  if (entry.kind === LOCAL_PROVIDER_KIND) return false;
  return !isLocalProviderUrl(entry.baseUrl ?? entry.url);
}
