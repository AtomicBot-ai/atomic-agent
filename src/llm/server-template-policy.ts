import type { ModelProfile } from "./model-profile.js";

/**
 * Whether a local prompt is rendered through the model's own chat
 * template (llama-server `POST /apply-template`) and whether the
 * template's thinking switch is set.
 *
 * Only Gemma and Qwen have hand-built prompt profiles; every other GGUF
 * ran as `plain-instruct`, with no turn markers and no way to turn
 * thinking off. `auto` therefore means: use the server's template for
 * the families the runtime does not know, keep the hand-built framing
 * (and its KV layout) for the ones it does. `on` / `off` override that
 * either way — `on` for a Gemma/Qwen operator who wants the model's own
 * template, `off` for a template that misbehaves.
 *
 * The thinking switch is a template argument (`chat_template_kwargs:
 * {enable_thinking}`), so it only exists on the template path and only
 * for templates that read it (`profile.supportsThinkingSwitch`).
 */
export type ServerTemplateSetting = "auto" | "on" | "off";
export type ThinkingSetting = "auto" | "on" | "off";

export interface ServerTemplatePolicy {
  readonly useServerTemplate: boolean;
  /** `undefined` leaves the template's own default in place. */
  readonly enableThinking: boolean | undefined;
}

export const NO_SERVER_TEMPLATE: ServerTemplatePolicy = {
  useServerTemplate: false,
  enableThinking: undefined,
};

export function resolveServerTemplatePolicy(
  localModels: {
    useServerTemplate: ServerTemplateSetting;
    thinking: ThinkingSetting;
  },
  profile: ModelProfile,
): ServerTemplatePolicy {
  const setting = localModels.useServerTemplate;
  const useServerTemplate =
    setting === "on"
      ? true
      : setting === "off"
        ? false
        : profile.id === "plain-instruct";
  if (!useServerTemplate) return NO_SERVER_TEMPLATE;
  const thinking = localModels.thinking;
  const enableThinking =
    thinking === "auto" || profile.supportsThinkingSwitch !== true
      ? undefined
      : thinking === "on";
  return { useServerTemplate, enableThinking };
}
