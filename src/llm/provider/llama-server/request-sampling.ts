import type { ModelSamplingDefaults } from "../../../local-llm/catalog/gguf-sampling.js";
import {
  hasSamplingFields,
  layerSampling,
  samplingForMode,
  type LocalModelSampling,
  type SamplingMode,
} from "../../../local-llm/catalog/model-sampling-sets.js";
import type { LocalModelDef } from "../../../local-llm/catalog/models-catalog.js";
import type { ModelProfile } from "../../model-profile.js";
import {
  thinkingDisabledOnBuiltPrompt,
  type ThinkingSetting,
} from "../../server-template-policy.js";
import type { CompletionRequest } from "../completion-types.js";

/**
 * Which sampling one llama-server request carries (ATO-2482), in two
 * layers the client orders (`model-sampling-fields.ts`):
 *
 * - `userSampling`, the person's own set for this model: the override
 *   map (`localModels.modelSamplingOverrides[<id>]`) over an added
 *   model's own `sampling`. Used whether `localModels.modelSampling` is
 *   on or not, as Jan's and Goose's per-model settings are.
 * - `modelSampling`, what the model itself recommends: a curated entry's
 *   catalog `sampling` over the GGUF header's `general.sampling.*` (and
 *   a `generation_config.json` beside the file). Used only when
 *   `localModels.modelSampling` is on.
 *
 * Each set is picked for the request's thinking mode: a set's
 * `thinking` / `noThinking` fields replace its shared ones.
 */

/**
 * Whether this request lets the model think. Off when the model has no
 * reasoning channel, the caller asked for none (`disableThinking`, a
 * template switch set to false), or the hand-built prompt closes the
 * think block itself (`localModels.thinking: "off"` on a template with
 * a disabled marker, F49). Anything else leaves the model's default,
 * which for the thinking models in the catalog is to think.
 */
export function requestThinks(
  request: Pick<CompletionRequest, "chat" | "disableThinking">,
  profile: ModelProfile,
  thinking: ThinkingSetting,
): boolean {
  if (profile.reasoningStyle === "none") return false;
  if (request.disableThinking === true) return false;
  if (request.chat !== undefined) return request.chat.enableThinking !== false;
  return !thinkingDisabledOnBuiltPrompt(thinking, profile);
}

export interface RequestSamplingInput {
  profile: ModelProfile;
  /** The catalog entry for the served file, when one matches. */
  def: LocalModelDef | undefined;
  overrides: Readonly<Record<string, LocalModelSampling>> | undefined;
  thinks: boolean;
}

export interface RequestSampling {
  modelSampling?: ModelSamplingDefaults;
  userSampling?: ModelSamplingDefaults;
}

export function resolveRequestSampling(input: RequestSamplingInput): RequestSampling {
  const mode: SamplingMode = input.thinks ? "thinking" : "noThinking";
  const { def } = input;
  const custom = def?.family === "custom";
  const user = layerSampling(
    samplingForMode(def ? input.overrides?.[def.id] : undefined, mode),
    samplingForMode(custom ? def?.sampling : undefined, mode),
  );
  const model = layerSampling(
    samplingForMode(custom ? undefined : def?.sampling, mode),
    input.profile.sampling ?? {},
  );
  return {
    ...(hasSamplingFields(model) ? { modelSampling: model } : {}),
    ...(hasSamplingFields(user) ? { userSampling: user } : {}),
  };
}
