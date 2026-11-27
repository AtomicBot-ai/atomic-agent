import { isAbsolute } from "node:path";
import type { GgufMetadata } from "../catalog/gguf-metadata.js";
import { vocabSizeFromMetadata } from "../catalog/gguf-metadata.js";

/**
 * Draft-model speculative decoding (`--model-draft`, ATO-2424): a small
 * model of the same family proposes the next tokens and the big one
 * checks them in one pass, so a reply decodes faster with the same text.
 *
 * `localModels.managed.draftModel`:
 * - `"off"` (default): no draft, the launch is byte-identical.
 * - `"auto"`: the catalog's pairing for the chat model (`draftModelId`),
 *   when that draft is downloaded and fits.
 * - a catalog model id, or an absolute path to a `.gguf`: that draft.
 *
 * The draft never costs the chat model its context: the window is fitted
 * first, and the draft is added only when its weights, its own cache at
 * that window and a compute reserve fit in what the window left
 * (`decideDraftLaunch`). Speculative decoding needs a draft with the same
 * tokenizer, a target whose cache can drop rejected tokens (not a
 * recurrent or hybrid model), a GPU, and the llama-server engine: Atomic
 * Core clears speculative decoding on the TurboQuant provider (see
 * `core/core-speculative.ts`), so under Core the draft is skipped and
 * the reason logged.
 *
 * Precedent: LM Studio's "Speculative Decoding" draft picker (off by
 * default, compatible drafts only); llama.cpp's `llama-server -md`.
 */
export type DraftModelPreference = string;

export const DRAFT_MODEL_DEFAULT: DraftModelPreference = "off";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Why `raw` is not a `draftModel` value, or `null` when it is one. */
export function draftModelPreferenceProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return `expected "off", "auto", a model id or an absolute path to a .gguf, got ${JSON.stringify(raw)}`;
  }
  if (raw === "off" || raw === "auto") return null;
  if (isAbsolute(raw)) {
    return /\.gguf$/i.test(raw) ? null : `a draft model path must end in .gguf, got ${JSON.stringify(raw)}`;
  }
  return MODEL_ID.test(raw) ? null : `not a model id or an absolute path: ${JSON.stringify(raw)}`;
}

/** A draft file the launch may use. */
export interface DraftCandidate {
  /** The catalog id, `null` for a path the operator gave. */
  id: string | null;
  path: string;
  sizeBytes: number;
}

/**
 * Which draft the preference names for `model`, or why there is none.
 * `null` when the preference is `"off"`. Pure: `lookup` finds a catalog
 * model's file (`null` for an unknown id or a draft not downloaded) and
 * `statFile` a path's size (`null` when missing).
 */
export function resolveDraftCandidate(
  preference: DraftModelPreference | undefined,
  model: { id: string; draftModelId?: string },
  deps: {
    lookup: (id: string) => { known: boolean; path: string | null; sizeBytes: number };
    statFile: (path: string) => number | null;
  },
): { candidate: DraftCandidate } | { skip: string } | null {
  const pref = preference ?? DRAFT_MODEL_DEFAULT;
  if (pref === "off") return null;
  if (isAbsolute(pref)) {
    const size = deps.statFile(pref);
    return size === null ? { skip: `draft file not found: ${pref}` } : { candidate: { id: null, path: pref, sizeBytes: size } };
  }
  const id = pref === "auto" ? model.draftModelId : pref;
  if (!id) return { skip: `no draft model is paired with ${model.id} in the catalog` };
  if (id === model.id) return { skip: `${id} cannot draft for itself` };
  const found = deps.lookup(id);
  if (!found.known) return { skip: `unknown draft model ${id}` };
  if (found.path === null) return { skip: `draft model ${id} is not downloaded; run 'atomic-agent models pull ${id}'` };
  return { candidate: { id, path: found.path, sizeBytes: found.sizeBytes } };
}

/** llama.cpp's limit on how far the two vocabularies may differ (`common/speculative.cpp`). */
export const DRAFT_VOCAB_MAX_SIZE_DIFFERENCE = 128;

/**
 * Why the draft cannot draft for the target, from the two headers, or
 * `null` when nothing read says so. llama.cpp refuses a draft whose
 * tokenizer type, start or end token differ, or whose vocabulary size is
 * more than 128 apart; a field one header does not carry is not held
 * against it (the launch retries without the draft if llama.cpp refuses).
 */
export function draftVocabProblem(target: GgufMetadata, draft: GgufMetadata): string | null {
  for (const key of ["tokenizer.ggml.model", "tokenizer.ggml.bos_token_id", "tokenizer.ggml.eos_token_id"]) {
    const a = target.keys[key];
    const b = draft.keys[key];
    if (a !== undefined && b !== undefined && a !== b) {
      return `the draft's tokenizer differs (${key}: ${JSON.stringify(b)} vs ${JSON.stringify(a)})`;
    }
  }
  const va = vocabSizeFromMetadata(target);
  const vb = vocabSizeFromMetadata(draft);
  if (va !== null && vb !== null && Math.abs(va - vb) > DRAFT_VOCAB_MAX_SIZE_DIFFERENCE) {
    return `the draft's vocabulary has ${vb} tokens, the model's ${va}`;
  }
  return null;
}

/** Room left for llama.cpp's own buffers of the draft context. */
export const DRAFT_COMPUTE_RESERVE_BYTES = 256 * 1024 * 1024;

export interface DraftLaunchInput {
  candidate: DraftCandidate;
  /** `true` when the operator named the draft (an id or a path), not `"auto"`. */
  explicit: boolean;
  engine: "llama-server" | "atomic-core";
  /** The launch's device: `"cpu"` gets no draft. */
  device: string | undefined;
  /** The chat model's cache cannot drop rejected tokens (recurrent / hybrid). */
  targetRecurrent: boolean;
  vocabProblem: string | null;
  /** The window the chat model was fitted to; the draft's cache is sized to it. */
  contextSize: number;
  /** What the cache may take on the device (`resolveEffectiveContextSize`); `null` unknown. */
  kvBudgetBytes: number | null;
  /** What the chat model's cache takes at `contextSize`. */
  mainKvBytes: number;
  /** The draft's cache at `contextSize` (f16, llama.cpp's draft default). */
  draftKvBytes: number;
  /** `--device` of the launch, mirrored to the draft so it lands where it was weighed. */
  pinnedDevice: string | null;
}

export interface DraftLaunchDecision {
  args: string[];
  /** The draft's catalog id or path, set only when it joins the launch. */
  draft?: string;
  /** The `[atomic-agent] launch: draft: ...` text. */
  reason: string;
}

const GIB = 1024 * 1024 * 1024;
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * Whether the draft joins this launch, and its flags. The chat model's
 * window is already fitted; the draft only takes what that left
 * (`kvBudgetBytes - mainKvBytes`). An
 * unknown budget (pinned context, no free figure) keeps a draft the
 * operator named, with a note that memory was not checked, and drops an
 * `"auto"` one.
 */
export function decideDraftLaunch(input: DraftLaunchInput): DraftLaunchDecision {
  const name = input.candidate.id ?? input.candidate.path;
  const skip = (why: string): DraftLaunchDecision => ({ args: [], reason: `draft: off (${name}: ${why})` });
  if (input.engine === "atomic-core") {
    return skip("Atomic Core does not run speculative decoding on this engine yet; set localModels.managed.engine to llama-server");
  }
  if (input.device === "cpu") return skip("speculative decoding needs a GPU");
  if (input.targetRecurrent) return skip("the model keeps a recurrent state, which cannot take back rejected draft tokens");
  if (input.vocabProblem) return skip(input.vocabProblem);
  const cost = input.candidate.sizeBytes + input.draftKvBytes + DRAFT_COMPUTE_RESERVE_BYTES;
  let fit: string;
  if (input.kvBudgetBytes === null) {
    if (!input.explicit) return skip("free memory unknown, so it could not be checked");
    fit = `memory not checked, about ${gib(cost)}`;
  } else {
    const left = input.kvBudgetBytes - input.mainKvBytes;
    if (cost > left) return skip(`needs ${gib(cost)}, only ${gib(Math.max(0, left))} left after the context window`);
    fit = `${gib(cost)} of ${gib(left)} left after the context window`;
  }
  const args = ["--model-draft", input.candidate.path, "--gpu-layers-draft", "999"];
  if (input.contextSize > 0) args.push("--ctx-size-draft", String(input.contextSize));
  if (input.pinnedDevice) args.push("--device-draft", input.pinnedDevice);
  return { args, draft: name, reason: `draft: on (${name}, ${fit})` };
}

/** The flags `decideDraftLaunch` emits, each of which a build's `--help` must list. */
export function draftFlagsMissing(args: readonly string[], helpText: string): string[] {
  return args
    .filter((a) => a.startsWith("--"))
    .filter((flag) => !new RegExp(`(^|[\\s,])${flag.replace(/-/g, "\\-")}(?![\\w-])`, "m").test(helpText));
}

/**
 * The one retry a launch with a draft gets when it fails: the same launch
 * without it (`draftModel: "off"`), so a draft llama.cpp refuses never
 * keeps the chat model from starting. `null`: no draft was on, or the
 * caller cancelled.
 */
export function draftRetryOptions<T extends { draftModel?: DraftModelPreference; signal?: AbortSignal }>(
  opts: T,
  draftArgs: readonly string[],
  err: unknown,
): (T & { draftModel: "off" }) | null {
  if (draftArgs.length === 0) return null;
  if (opts.signal?.aborted) return null;
  if (err instanceof Error && err.name === "AbortError") return null;
  return { ...opts, draftModel: "off" };
}

export const DRAFT_RETRY_NOTE =
  "[atomic-agent] launch: draft: the load with a draft model failed; retrying once without --model-draft\n";
