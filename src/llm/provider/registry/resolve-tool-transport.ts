import type { ToolCallTransport } from "../completion-types.js";
import type { LlmProvider } from "../llm-provider.js";
import type { ResolvedLlmConfig } from "./provider-types.js";

/**
 * Resolve the effective tool transport for the active text provider.
 * `auto` follows the provider's declared capability.
 */
export function resolveActiveToolTransport(
  llmConfig: ResolvedLlmConfig,
  provider: LlmProvider,
): ToolCallTransport {
  if (llmConfig.toolTransport === "grammar") {
    return "grammar";
  }
  if (llmConfig.toolTransport === "native_tools") {
    return "native_tools";
  }
  return provider.capabilities.toolTransport;
}
