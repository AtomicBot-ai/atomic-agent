export type ReasoningStyle = "none" | "think-tags" | "channel-tags";

/**
 * How much of a prompt the serving model can reuse from its KV cache
 * when the prompt changes somewhere in the middle.
 *  - `"partial"` (default): everything before the first changed token is
 *    reused — dense attention, the ordinary llama-server case.
 *  - `"none"`: a change anywhere re-reads the whole prompt — sliding-
 *    window or hybrid/recurrent architectures (Gemma 4, Mamba-based),
 *    whose layers cannot roll back. Set by the daemon from the GGUF
 *    metadata; the packer then cuts history deeper and less often.
 */
export type PrefixReuse = "partial" | "none";

interface BaseModelProfile {
  requiresPromptThinkPrefix: boolean;
  allowThinkPrelude: boolean;
  /**
   * How much of a cached prompt llama-server can reuse when a new one
   * diverges from it — see `PrefixReuse`: `"partial"` (the default — the
   * matching prefix is kept and the rest re-evaluated) or `"none"` (a
   * sliding-window or hybrid/recurrent model launched without
   * `--swa-full`, whose layers cannot be rolled back, so a changed prompt
   * is a full re-read). Set from the model's GGUF header
   * (`gguf-metadata.ts`) by the profile manager; the conversation packer
   * cuts history less often and deeper when reuse is `"none"`. Absent
   * means `"partial"`.
   */
  prefixReuse?: PrefixReuse;
  /**
   * Physical context window in tokens, read from `llama-server /props`
   * (`default_generation_settings.n_ctx`, with a root `n_ctx` fallback).
   * Absent when the probe failed or an older llama.cpp build did not
   * expose it — prompt-building then relies purely on configured caps.
   */
  contextWindow?: number;
  /**
   * The chat template reads `enable_thinking` (Qwen, Gemma 4, Nemotron
   * and friends), so `chat_template_kwargs: { enable_thinking }` on a
   * server-templated request switches reasoning on or off. Absent on
   * templates that do not mention it. See `server-template-policy.ts`.
   */
  supportsThinkingSwitch?: boolean;
  /**
   * Multimodal (vision) capability snapshot derived from `/props`.
   *
   * `supported = true` iff llama-server reports an mmproj projector
   * is loaded (one of `has_multimodal`, `multimodal`, or a non-null
   * `mmproj` object at root or under `default_generation_settings`).
   * Older llama.cpp builds that pre-date the multimodal-in-`/props`
   * surface report `supported = false` and `source = "absent"` —
   * callers can fall back to `LocalModelDef.supportsVision` when the
   * server is text-only or the field is missing.
   */
  vision: VisionCapability;
  /**
   * Audio-input snapshot from `/props` (`modalities.audio`). Optional
   * so hand-built profile constants need not carry it: absent reads as
   * "no audio". `detectModelProfile` sets it only when `/props` says
   * the model hears.
   */
  audio?: AudioCapability;
}

export interface AudioCapability {
  supported: boolean;
  source: "modalities.audio" | "absent";
}

export interface VisionCapability {
  supported: boolean;
  /**
   * Which `/props` field signalled the capability. Recorded for
   * observability — the runtime never branches on the source, but
   * trace dumps and the bootstrap log line surface it for debugging.
   */
  source:
    | "modalities.vision"
    | "has_multimodal"
    | "multimodal"
    | "mmproj"
    | "default_generation_settings.has_multimodal"
    | "absent";
}

export interface PlainModelProfile extends BaseModelProfile {
  id: "plain-instruct";
  reasoningStyle: "none";
  reasoningSystemToken?: undefined;
}

/**
 * Native turn-token framing for templates (e.g. Gemma 4) whose reasoning
 * channel only activates when the `<|think|>` token sits inside a real
 * `<|turn>system>` block and the prompt ends at the model-turn opener.
 */
export interface ReasoningTurnFraming {
  /** Opens the system turn, e.g. `"<|turn>system\n"`. */
  systemOpen: string;
  /** Closes a turn, e.g. `"<turn|>\n"`. */
  turnClose: string;
  /** Opens the assistant/model turn at the generation point, e.g. `"<|turn>model\n"`. */
  assistantOpen: string;
}

export interface TaggedReasoningModelProfile extends BaseModelProfile {
  id: "qwen-think" | "gemma4-think";
  reasoningStyle: "think-tags" | "channel-tags";
  reasoningOpenTag: string;
  reasoningCloseTag: string;
  reasoningSystemToken?: string;
  /**
   * When `true`, the model emits its OWN reasoning open tag in the
   * completion: the prompt does NOT prefill it and the grammar's prelude
   * includes the open sentinel. When `false`/omitted, the open tag is
   * prefilled at the end of the prompt (legacy qwen behaviour) and
   * stripped from the completion before parsing.
   *
   * Gemma 4's QAT template treats a prefilled `<|channel>thought\n` as
   * the *thinking-disabled* marker and closes the channel immediately,
   * dumping its reasoning into the reply. Letting the model emit the open
   * tag itself (paired with `turnFraming`) is what actually activates the
   * channel.
   */
  reasoningEmittedByModel?: boolean;
  /**
   * Native turn-token framing for the prompt. When present, the prompt is
   * wrapped as one system turn (`systemOpen ... turnClose`) and ends with
   * `assistantOpen` at the generation point instead of a trailing
   * reasoning-open prefill.
   */
  turnFraming?: ReasoningTurnFraming;
  /**
   * What the model's own chat template puts at the generation point
   * when thinking is switched off — for Qwen, `<think>\n\n</think>\n\n`,
   * an empty block the model reads as "do not reason". Present only
   * where a prefilled marker really disables reasoning. Gemma 4 carries
   * none: its disabled marker is the prefilled channel, which the turn
   * framing above exists to avoid. `localModels.thinking: "off"` on the
   * hand-built prompt path ends the prompt with this instead of the open
   * tag and drops the grammar prelude (F49, `thinkingDisabledOnBuiltPrompt`).
   */
  promptThinkingDisabledMarker?: string;
}

export type ModelProfile = PlainModelProfile | TaggedReasoningModelProfile;

/**
 * True when the model emits its own reasoning open tag (so the runtime
 * must not prefill it, must not prepend it before parsing, and the
 * grammar prelude includes the open sentinel).
 */
export function reasoningOpenEmittedByModel(profile: ModelProfile): boolean {
  return (
    profile.reasoningStyle !== "none" &&
    profile.reasoningEmittedByModel === true
  );
}

/** Turn-token framing for the prompt, when the profile requires it. */
export function getReasoningTurnFraming(
  profile: ModelProfile,
): ReasoningTurnFraming | undefined {
  return profile.reasoningStyle !== "none" ? profile.turnFraming : undefined;
}

/** Default vision snapshot for hand-built profile constants — overwritten by `detectModelProfile`. */
const VISION_ABSENT: VisionCapability = { supported: false, source: "absent" };

export const PLAIN_INSTRUCT_PROFILE: PlainModelProfile = {
  id: "plain-instruct",
  reasoningStyle: "none",
  requiresPromptThinkPrefix: false,
  allowThinkPrelude: false,
  vision: VISION_ABSENT,
};

export const QWEN_THINK_PROFILE: TaggedReasoningModelProfile = {
  id: "qwen-think",
  reasoningStyle: "think-tags",
  reasoningOpenTag: "<think>",
  reasoningCloseTag: "</think>",
  requiresPromptThinkPrefix: true,
  allowThinkPrelude: true,
  supportsThinkingSwitch: true,
  // The Qwen template's `enable_thinking: false` rendering: an empty,
  // closed think block at the generation point.
  promptThinkingDisabledMarker: "<think>\n\n</think>\n\n",
  vision: VISION_ABSENT,
};

export const GEMMA4_THINK_PROFILE: TaggedReasoningModelProfile = {
  id: "gemma4-think",
  reasoningStyle: "channel-tags",
  reasoningOpenTag: "<|channel>thought\n",
  reasoningCloseTag: "<channel|>",
  reasoningSystemToken: "<|think|>\n",
  requiresPromptThinkPrefix: true,
  allowThinkPrelude: true,
  // Gemma 4 only reasons when `<|think|>` sits inside a real `<|turn>system>`
  // block and the prompt ends at `<|turn>model\n` (no channel prefill); the
  // model then opens its own `<|channel>thought` block. See README.md.
  reasoningEmittedByModel: true,
  turnFraming: {
    systemOpen: "<|turn>system\n",
    turnClose: "<turn|>\n",
    assistantOpen: "<|turn>model\n",
  },
  supportsThinkingSwitch: true,
  vision: VISION_ABSENT,
};

/**
 * What decided the profile: `"template"` when the chat template alone
 * identified the reasoning framing, `"name"` when an alias / GGUF file
 * name hint was needed on top of the template, `"fallback"` when nothing
 * matched and the model runs as `plain-instruct`. Logged on the
 * "model profile resolved" line so a wrong profile can be traced to its
 * cause from the boot log.
 */
export type ModelProfileMatch = "template" | "name" | "fallback";

export interface DetectedModelProfile {
  profile: ModelProfile;
  matchedBy: ModelProfileMatch;
}

export function detectModelProfile(
  props: Record<string, unknown>,
): ModelProfile {
  return detectModelProfileWithMatch(props).profile;
}

/** `detectModelProfile` plus which signal decided it (see `ModelProfileMatch`). */
export function detectModelProfileWithMatch(
  props: Record<string, unknown>,
): DetectedModelProfile {
  const modelNames = readModelNameHints(props);
  const chatTemplate = readString(props.chat_template);
  const templateLower = chatTemplate.toLowerCase();
  const caps = readObject(props.chat_template_caps);
  const supportsPreserveReasoning =
    readBoolean(caps.supports_preserve_reasoning) ?? false;

  const { profile: base, matchedBy } = selectBaseProfile(
    modelNames,
    templateLower,
    supportsPreserveReasoning,
  );
  const contextWindow = readContextWindow(props);
  const vision = detectVisionSupport(props);
  const audio = detectAudioSupport(props);
  const enriched = {
    ...base,
    ...(templateLower.includes("enable_thinking")
      ? { supportsThinkingSwitch: true }
      : {}),
    vision,
    // Only when present, so a text/vision profile keeps its exact shape.
    ...(audio.supported ? { audio } : {}),
  } as ModelProfile;
  if (contextWindow === null) return { profile: enriched, matchedBy };
  return { profile: { ...enriched, contextWindow }, matchedBy };
}

/**
 * Detect mmproj/multimodal support from a `/props` payload. We check
 * signals in priority order, newest llama.cpp surface first:
 *
 * 1. `modalities.vision: true` — current canonical surface (build
 *    `b1-*` and later). The companion `modalities.audio` flag is read
 *    separately by `detectAudioSupport` (for `audio.listen`).
 * 2. Top-level `has_multimodal: true` — older `mtmd` surface.
 * 3. Top-level `multimodal: true` — fork variant.
 * 4. Non-null `mmproj` object (path / n_embd / etc.) at root or
 *    under `default_generation_settings` — present on builds that
 *    expose the projector blob directly.
 * 5. `default_generation_settings.has_multimodal: true` — legacy
 *    placement of the same flag.
 *
 * Anything else means `supported: false`. The caller (bootstrap)
 * combines this with `config.vision.autoDetect` to decide whether to
 * register the `vision.describe` tool.
 */
export function detectVisionSupport(
  props: Record<string, unknown>,
): VisionCapability {
  const modalities = readObject(props.modalities);
  if (readBoolean(modalities.vision) === true) {
    return { supported: true, source: "modalities.vision" };
  }
  if (readBoolean(props.has_multimodal) === true) {
    return { supported: true, source: "has_multimodal" };
  }
  if (readBoolean(props.multimodal) === true) {
    return { supported: true, source: "multimodal" };
  }
  const mmproj = props.mmproj;
  if (mmproj && typeof mmproj === "object" && !Array.isArray(mmproj)) {
    return { supported: true, source: "mmproj" };
  }
  const defaults = readObject(props.default_generation_settings);
  if (readBoolean(defaults.has_multimodal) === true) {
    return {
      supported: true,
      source: "default_generation_settings.has_multimodal",
    };
  }
  return { supported: false, source: "absent" };
}

/**
 * Whether the loaded model takes audio input: llama-server reports
 * `modalities.audio: true` when the projector it loaded has an audio
 * encoder. Only that field counts — the older `has_multimodal` /
 * `mmproj` signals do not say which modality the projector serves, so
 * they are not read as audio.
 */
export function detectAudioSupport(
  props: Record<string, unknown>,
): AudioCapability {
  const modalities = readObject(props.modalities);
  if (readBoolean(modalities.audio) === true) {
    return { supported: true, source: "modalities.audio" };
  }
  return { supported: false, source: "absent" };
}

function selectBaseProfile(
  modelAlias: string,
  templateLower: string,
  supportsPreserveReasoning: boolean,
): DetectedModelProfile {
  // The template is what the model was trained on; the alias is whatever
  // the operator (or our daemon) typed. A full Gemma 4 native thinking
  // template decides on its own, before any alias-gated branch: Gemma 4
  // fine-tunes ship under other names (Nemotron 3.5 Bolt E4B carries a
  // `nemotron` name and the Gemma 4 template, ATO-879), and a qwen- or
  // nemotron-named alias must not push a `<|turn>`-framed model onto the
  // ChatML `<think>` prefill.
  if (hasGemma4NativeThinkTemplate(templateLower)) {
    return { profile: GEMMA4_THINK_PROFILE, matchedBy: "template" };
  }
  if (
    looksLikeQwenThinkModel(
      modelAlias,
      templateLower,
      supportsPreserveReasoning,
    )
  ) {
    return { profile: QWEN_THINK_PROFILE, matchedBy: "name" };
  }
  // Nemotron needs its own detector but not its own profile. Its ChatML
  // template is qwen-shaped — `<think>`/`</think>` prefilled at the
  // generation point, same open/close ownership, no turn framing — so the
  // runtime behaviour is byte-for-byte `QWEN_THINK_PROFILE`. Only the alias
  // gate differs: `looksLikeQwenThinkModel` requires a qwen/qwq/deepseek-r1
  // alias, which Nemotron's does not match, so without this branch it would
  // fall through to `plain-instruct` and lose its reasoning channel.
  if (looksLikeNemotronThinkModel(modelAlias, templateLower)) {
    return { profile: QWEN_THINK_PROFILE, matchedBy: "name" };
  }
  // No name hint, but the template itself is the ChatML + `<think>`
  // framing QWEN_THINK_PROFILE reproduces (ATO-1294): a Qwen or Nemotron
  // fine-tune served under a neutral `--alias` / file name keeps its
  // reasoning channel. The signature is strict on purpose — see
  // `hasChatMlThinkTemplate` — so GLM-style or Harmony templates that
  // merely mention `<think>` stay plain.
  if (hasChatMlThinkTemplate(templateLower, supportsPreserveReasoning)) {
    return { profile: QWEN_THINK_PROFILE, matchedBy: "template" };
  }
  if (looksLikeGemma4ThinkModel(modelAlias, templateLower)) {
    return { profile: GEMMA4_THINK_PROFILE, matchedBy: "name" };
  }
  return { profile: PLAIN_INSTRUCT_PROFILE, matchedBy: "fallback" };
}

/**
 * Extract the physical context window from a `/props` payload. Current
 * llama.cpp builds nest it under `default_generation_settings.n_ctx`; we
 * also fall back to a root-level `n_ctx` for older builds and custom
 * forks. Returns `null` when neither is a positive number.
 */
/**
 * Extract `total_slots` from a `/props` payload — the number of parallel
 * slots llama-server was started with (`--parallel`). Anything missing,
 * non-finite, or below 1 collapses to `null` so callers fall back to the
 * conservative `SlotManager` default rather than guessing high: an id
 * above the real count is wrapped by llama.cpp (`id_slot % n_slots`) into
 * a *different session's* slot, silently thrashing the KV cache.
 */
export function extractTotalSlots(
  props: Record<string, unknown>,
): number | null {
  const raw = props.total_slots;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return null;
  }
  return Math.trunc(raw);
}

function readContextWindow(props: Record<string, unknown>): number | null {
  const defaults = readObject(props.default_generation_settings);
  const nested = toPositiveInt(defaults.n_ctx);
  if (nested !== null) return nested;
  return toPositiveInt(props.n_ctx);
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function looksLikeQwenThinkModel(
  modelAlias: string,
  templateLower: string,
  supportsPreserveReasoning: boolean,
): boolean {
  const aliasHint =
    modelAlias.includes("qwen") ||
    modelAlias.includes("qwq") ||
    modelAlias.includes("deepseek-r1");
  const templateHint =
    templateLower.includes("<think>") &&
    (templateLower.includes("enable_thinking") ||
      templateLower.includes("preserve_thinking") ||
      supportsPreserveReasoning);
  return aliasHint && templateHint;
}

function looksLikeNemotronThinkModel(
  modelAlias: string,
  templateLower: string,
): boolean {
  const aliasHint = modelAlias.includes("nemotron");
  const templateHint =
    templateLower.includes("<think>") &&
    templateLower.includes("enable_thinking");
  return aliasHint && templateHint;
}

function looksLikeGemma4ThinkModel(
  modelAlias: string,
  templateLower: string,
): boolean {
  const aliasHint = modelAlias.includes("gemma");
  const templateHint =
    templateLower.includes("<|channel>thought") &&
    (templateLower.includes("<|turn>") || templateLower.includes("<turn|>"));
  return aliasHint && templateHint;
}

/**
 * The Gemma 4 thinking template, recognised from the template alone: it
 * emits the system-turn opener, the `<|think|>` switch token, the
 * model-turn opener at the generation point and the `<|channel>thought`
 * channel. All four must be present, so a template that merely mentions
 * the channel tags (stripping them from history, say) does not qualify —
 * it is the framing `GEMMA4_THINK_PROFILE` reproduces by hand, so a
 * template that writes it is one the profile fits.
 */
function hasGemma4NativeThinkTemplate(templateLower: string): boolean {
  return (
    templateLower.includes("<|channel>thought") &&
    templateLower.includes("<|think|>") &&
    templateLower.includes("<|turn>system") &&
    templateLower.includes("<|turn>model")
  );
}

/**
 * The ChatML thinking template, recognised from the template alone
 * (ATO-1294). Qwen 3 and Nemotron both ship it: ChatML turn markers
 * (`<|im_start|>` and `<|im_end|>`), a `<think>`/`</think>` pair, a
 * thinking control (`enable_thinking` / `preserve_thinking`, or the
 * server's `supports_preserve_reasoning` cap), and — the strict part — a
 * generation prompt that opens the assistant turn and writes `<think>`
 * itself. That last check reads only what follows the final
 * `add_generation_prompt`, so a ChatML template that just strips old
 * `<think>` blocks from history (a non-thinking fine-tune) does not
 * qualify. GLM's `<|assistant|>` framing and Harmony's
 * `<|start|>`/`<|channel|>` framing carry no ChatML markers and never
 * match.
 */
function hasChatMlThinkTemplate(
  templateLower: string,
  supportsPreserveReasoning: boolean,
): boolean {
  if (
    !templateLower.includes("<|im_start|>") ||
    !templateLower.includes("<|im_end|>") ||
    !templateLower.includes("<think>") ||
    !templateLower.includes("</think>")
  ) {
    return false;
  }
  const hasThinkingControl =
    templateLower.includes("enable_thinking") ||
    templateLower.includes("preserve_thinking") ||
    supportsPreserveReasoning;
  if (!hasThinkingControl) return false;
  const generationAt = templateLower.lastIndexOf("add_generation_prompt");
  if (generationAt < 0) return false;
  const generation = templateLower.slice(generationAt);
  return (
    generation.includes("<|im_start|>assistant") &&
    generation.includes("<think>")
  );
}

/**
 * Lower-cased model names to match the alias hints against: the served
 * alias plus the GGUF file name from `/props.model_path`. The managed
 * daemon serves under a catalog id (`-a <model.id>`), an external server
 * under whatever `--alias` was given or the model path; adding the file
 * name keeps the same GGUF on the same profile whichever way it was
 * launched. Only the base name is read, so a directory such as
 * `~/qwen-models/` cannot lend its name to an unrelated file.
 */
function readModelNameHints(props: Record<string, unknown>): string {
  const alias = readString(props.model_alias).toLowerCase();
  const fileName =
    readString(props.model_path).split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!fileName || alias.includes(fileName)) return alias;
  return alias ? `${alias} ${fileName}` : fileName;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
