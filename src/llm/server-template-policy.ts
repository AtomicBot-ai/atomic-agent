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
 * {enable_thinking}`) on the template path, for templates that read it
 * (`profile.supportsThinkingSwitch`). On the hand-built path `off` is
 * honoured where the template has a prompt-side disabled marker —
 * `thinkingDisabledOnBuiltPrompt` below (F49).
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

/**
 * Whether `localModels.thinking: "off"` turns reasoning off on the
 * HAND-BUILT prompt path (F49). Only a profile whose template has a
 * prompt-side disabled marker (`qwen-think`: `<think>\n\n</think>\n\n`)
 * can honour it there: the prompt ends with that marker instead of the
 * open-tag prefill, the request grammar drops the reasoning prelude
 * (`withoutReasoningPrelude`), and the completion is parsed as starting
 * outside a think block. Gemma 4's turn framing has no such marker — a
 * prefilled channel is its disabled marker, and the framing exists to
 * avoid exactly that — so `off` leaves it as is. `on` / `auto` change
 * nothing. Callers scope it to the built-prompt path: the template path
 * has its own switch above.
 */
export function thinkingDisabledOnBuiltPrompt(
  thinking: ThinkingSetting,
  profile: ModelProfile,
): boolean {
  return (
    thinking === "off" &&
    profile.reasoningStyle !== "none" &&
    profile.promptThinkingDisabledMarker !== undefined
  );
}
