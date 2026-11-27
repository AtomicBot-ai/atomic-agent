import { existsSync } from "node:fs";

import { getConfig } from "../config/index.js";
import {
  readModelSamplingSetting,
  writeModelSamplingSetting,
} from "../config/model-sampling-store.js";
import { resolveChatModelWeightsPath } from "../local-llm/backend-paths.js";
import {
  loadModelSamplingDefaults,
  type ModelSamplingDefaults,
} from "../local-llm/catalog/gguf-sampling.js";
import {
  isEmptyLocalModelSampling,
  parseLocalModelSampling,
  SamplingSetError,
  type LocalModelSampling,
} from "../local-llm/catalog/model-sampling-sets.js";
import { listLocalModels, type LocalModelDef } from "../local-llm/catalog/models-catalog.js";
import { formatSamplingReport, type SamplingReport } from "./models-sampling-format.js";

/**
 * `atomic-agent models sampling <id> [--temperature <n>] [--top-p <n>]
 * [--top-k <n>] [--min-p <n>] [--presence-penalty <n>] [--repeat-penalty <n>]
 * [--thinking | --no-thinking] [--set <json>] [--reset] [--json]` (ATO-2482).
 *
 * Without a value flag it shows what the model runs with: the person's
 * own set ("custom") or the model's default (catalog entry, then the
 * file's header / generation_config.json). A value flag writes the
 * person's set for that model, merged into what is already set;
 * `--thinking` / `--no-thinking` scope the values to one mode. `--reset`
 * goes back to the model's default. `--set <json>` replaces the person's
 * whole set at once (both modes), which is what the desktop's Sampling row
 * sends, reading the result back with `--json`. Precedent: Jan's and Goose's per-model
 * sampling settings, LM Studio's per-model "Inference" presets.
 */

export const SAMPLING_HELP =
  [
    "atomic-agent models sampling: show or set one local model's sampling",
    "",
    "Usage:",
    "  atomic-agent models sampling <id> [--json]",
    "  atomic-agent models sampling <id> [--thinking | --no-thinking] --temperature <n> ...",
    "  atomic-agent models sampling <id> --set '{\"temperature\":0.7,\"noThinking\":{\"topP\":0.8}}'",
    "  atomic-agent models sampling <id> --reset",
    "",
    "  --temperature <n>       0 to 5",
    "  --top-p <n>             above 0, up to 1",
    "  --top-k <n>             a whole number, 0 turns it off",
    "  --min-p <n>             0 to 1",
    "  --presence-penalty <n>  -2 to 2",
    "  --repeat-penalty <n>    above 0, up to 5 (1 turns it off)",
    "  --thinking              The values apply only while the model thinks",
    "  --no-thinking           The values apply only with thinking off",
    "  --set <json>            Replace your whole set (fields as above in camelCase,",
    "                          plus thinking / noThinking for one mode)",
    "  --reset                 Back to the model's default",
    "  --json                  Print the result as JSON",
    "",
    "Your own values always apply. The model's default applies only when",
    "localModels.modelSampling is on; otherwise the built-in 0.2 / 0.95 / 40 does.",
  ].join("\n") + "\n";

const VALUE_FLAGS: Readonly<Record<string, keyof ModelSamplingDefaults>> = {
  "--temperature": "temperature",
  "--top-p": "topP",
  "--top-k": "topK",
  "--min-p": "minP",
  "--presence-penalty": "presencePenalty",
  "--repeat-penalty": "repeatPenalty",
};

export interface SamplingArgs {
  id: string;
  values: ModelSamplingDefaults;
  mode: "both" | "thinking" | "noThinking";
  /** `--set`: the whole set, parsed from JSON but not yet validated. */
  replace?: unknown;
  reset: boolean;
  json: boolean;
}

export function parseSamplingArgs(
  args: readonly string[],
): SamplingArgs | { help: true } | { error: string } {
  const out: SamplingArgs = { id: "", values: {}, mode: "both", reset: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    if (flag === "-h" || flag === "--help") return { help: true };
    if (flag === "--json") out.json = true;
    else if (flag === "--reset") out.reset = true;
    else if (flag === "--set") {
      const raw = args[i + 1];
      if (raw === undefined) return { error: "--set needs a JSON object" };
      try {
        out.replace = JSON.parse(raw);
      } catch {
        return { error: "--set needs a JSON object" };
      }
      i += 1;
    } else if (flag === "--thinking" || flag === "--no-thinking") {
      const mode = flag === "--thinking" ? "thinking" : "noThinking";
      if (out.mode !== "both" && out.mode !== mode) {
        return { error: "--thinking and --no-thinking cannot be used together" };
      }
      out.mode = mode;
    } else if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const field = VALUE_FLAGS[flag]!;
      const raw = args[i + 1];
      const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
      if (!Number.isFinite(value)) return { error: `${flag} needs a number` };
      out.values[field] = value;
      i += 1;
    } else if (flag.startsWith("-")) {
      return { error: `unknown flag ${flag}` };
    } else if (out.id === "") out.id = flag;
    else return { error: `one model id only, got ${flag} too` };
  }
  if (out.id === "") return { error: "name a model id (see atomic-agent models list)" };
  const changes = [out.reset, out.replace !== undefined, Object.keys(out.values).length > 0];
  if (changes.filter(Boolean).length > 1) {
    return { error: "use one of --reset, --set or value flags" };
  }
  return out;
}

/** The person's set with `values` merged in, for one mode or both. */
export function mergeSamplingValues(
  current: LocalModelSampling | null,
  values: ModelSamplingDefaults,
  mode: SamplingArgs["mode"],
): LocalModelSampling {
  const next: LocalModelSampling = { ...(current ?? {}) };
  if (mode === "both") return { ...next, ...values };
  next[mode] = { ...(next[mode] ?? {}), ...values };
  return next;
}

function findModel(id: string): LocalModelDef | undefined {
  return listLocalModels().find((m) => m.id === id);
}

async function buildReport(def: LocalModelDef): Promise<SamplingReport> {
  const config = getConfig();
  const custom = readModelSamplingSetting(def.id);
  const weights = resolveChatModelWeightsPath(config.paths.localModelsDataDir, def);
  const fromFile = existsSync(weights) ? await loadModelSamplingDefaults(weights) : null;
  return {
    id: def.id,
    name: def.name,
    source: custom && !isEmptyLocalModelSampling(custom) ? "custom" : "default",
    custom,
    catalog: def.family === "custom" ? null : (def.sampling ?? null),
    file: fromFile,
    modelSampling: config.localModels.modelSampling === true,
  };
}

export async function runModelsSampling(args: readonly string[]): Promise<number> {
  const parsed = parseSamplingArgs(args);
  if ("help" in parsed) {
    process.stdout.write(SAMPLING_HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`models sampling: ${parsed.error}\n${SAMPLING_HELP}`);
    return 2;
  }
  const def = findModel(parsed.id);
  if (!def) {
    process.stderr.write(
      `models sampling: no local model ${JSON.stringify(parsed.id)} (see atomic-agent models list)\n`,
    );
    return 2;
  }
  if (parsed.reset) {
    writeModelSamplingSetting(def.id, null);
  } else if (parsed.replace !== undefined || Object.keys(parsed.values).length > 0) {
    const merged =
      parsed.replace !== undefined
        ? parsed.replace
        : mergeSamplingValues(readModelSamplingSetting(def.id), parsed.values, parsed.mode);
    let checked: LocalModelSampling | undefined;
    try {
      checked = parseLocalModelSampling(merged, "sampling");
    } catch (err) {
      if (!(err instanceof SamplingSetError)) throw err;
      process.stderr.write(`models sampling: ${err.field}: ${err.message}\n`);
      return 2;
    }
    writeModelSamplingSetting(def.id, checked ?? null);
  }
  const report = await buildReport(def);
  process.stdout.write(
    parsed.json ? `${JSON.stringify(report)}\n` : formatSamplingReport(report),
  );
  return 0;
}
