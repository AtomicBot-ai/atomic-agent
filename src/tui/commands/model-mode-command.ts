import { getConfig } from "../../config/index.js";
import { setModelModeInConfig } from "../../config/model-mode-commands.js";
import type { ModelMode } from "../../config/model-mode.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-types.js";
import { captureModelModePolicy, resolveModelMode } from "../../llm/model-mode.js";
import type { TuiAction } from "../tui-action.js";

export interface ModelModeCommand {
  mode?: ModelMode | "inherit";
  providerId?: string;
  modelId?: string;
}

export const MODEL_MODE_USAGE =
  "usage: /llm model-mode [local|cloud|inherit] [provider-id] [model-id]";

export function parseModelModeCommand(args: string): ModelModeCommand | null {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return {};
  const [mode, providerId, modelId] = words;
  if (words.length > 3 || (mode !== "local" && mode !== "cloud" && mode !== "inherit")) return null;
  return { mode, ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}) };
}

/** The submit path owns persistence; parsing and reducers stay pure. */
export function runModelModeCommand(command: ModelModeCommand, dispatch: (action: TuiAction) => void): void {
  try {
    if (command.mode) {
      setModelModeInConfig({
        providerId: command.providerId,
        modelId: command.modelId,
        mode: command.mode === "inherit" ? null : command.mode,
      });
    }
    const config = getConfig();
    const llm = resolveLlmConfig(config);
    const policy = captureModelModePolicy(llm, (id) => {
      const entry = llm.providers.find((provider) => provider.id === id);
      return entry?.defaultChatModel ?? entry?.model ??
        (entry?.kind === "llama-server" ? config.localModels.managed.modelId : null);
    });
    const selected = resolveModelMode(policy, command.providerId, command.modelId);
    const change = command.mode
      ? `Saved ${command.modelId ? "model override" : "provider default"}: ${command.mode}. Applies from the next turn. `
      : "Saved policy for the next turn: ";
    dispatch({
      type: "system_message",
      text: `${change}${selected.providerId}${selected.modelId ? ` / ${selected.modelId}` : ""}: ${selected.mode} (${selected.source}). ${selected.mode === "cloud" ? "Cloud context keeps full results and instructions in an append-only message history." : "Local context uses the existing packing and limits."}`,
    });
  } catch (error) {
    dispatch({ type: "system_message", text: `model mode: ${error instanceof Error ? error.message : String(error)}` });
  }
}
