import type { ModelSamplingDefaults } from "../local-llm/catalog/gguf-sampling.js";
import {
  hasSamplingFields,
  layerSampling,
  samplingForMode,
  type LocalModelSampling,
} from "../local-llm/catalog/model-sampling-sets.js";

/**
 * What `atomic-agent models sampling <id>` reports (ATO-2482); the
 * desktop reads the same object from `--json`.
 */
export interface SamplingReport {
  id: string;
  name: string;
  /** `custom` when the person set values for this model. */
  source: "custom" | "default";
  /** The person's own set, or `null`. */
  custom: LocalModelSampling | null;
  /** The catalog entry's set (curated models), or `null`. */
  catalog: LocalModelSampling | null;
  /** What the downloaded file's header or generation_config.json says, or `null`. */
  file: ModelSamplingDefaults | null;
  /** `localModels.modelSampling`: whether the model's default is used at all. */
  modelSampling: boolean;
}

const LABELS: ReadonlyArray<[keyof ModelSamplingDefaults, string]> = [
  ["temperature", "temperature"],
  ["topP", "top-p"],
  ["topK", "top-k"],
  ["minP", "min-p"],
  ["presencePenalty", "presence penalty"],
  ["repeatPenalty", "repeat penalty"],
  ["repeatLastN", "repeat window"],
];

export function describeSampling(set: ModelSamplingDefaults): string {
  const parts = LABELS.flatMap(([field, label]) =>
    set[field] === undefined ? [] : [`${label} ${set[field]}`],
  );
  return parts.length > 0 ? parts.join(", ") : "built-in values";
}

/** The model's default for one mode: catalog set over the file's values. */
function defaultFor(report: SamplingReport, mode: "thinking" | "noThinking"): ModelSamplingDefaults {
  return layerSampling(samplingForMode(report.catalog ?? undefined, mode), report.file ?? {});
}

export function formatSamplingReport(report: SamplingReport): string {
  const lines = [
    `${report.name} (${report.id})`,
    `Sampling: ${report.source === "custom" ? "custom" : "model default"}`,
  ];
  for (const [mode, label] of [
    ["thinking", "Thinking on: "],
    ["noThinking", "Thinking off:"],
  ] as const) {
    const own = samplingForMode(report.custom ?? undefined, mode);
    const fallback = defaultFor(report, mode);
    const shown = report.modelSampling ? layerSampling(own, fallback) : own;
    lines.push(`  ${label} ${describeSampling(shown)}`);
  }
  if (!report.modelSampling) {
    const anyDefault =
      hasSamplingFields(defaultFor(report, "thinking")) ||
      hasSamplingFields(defaultFor(report, "noThinking"));
    lines.push(
      anyDefault
        ? "The model's own values are off (localModels.modelSampling); fields you did not set use the built-in 0.2 / 0.95 / 40."
        : "Fields you did not set use the built-in 0.2 / 0.95 / 40.",
    );
  }
  lines.push(
    report.source === "custom"
      ? `Back to the model's default: atomic-agent models sampling ${report.id} --reset`
      : `Set your own: atomic-agent models sampling ${report.id} --temperature 0.7`,
  );
  return `${lines.join("\n")}\n`;
}
