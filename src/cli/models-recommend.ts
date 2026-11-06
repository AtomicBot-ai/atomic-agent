/**
 * `models recommend [--json]` and `models upgrade [--json] [--dry-run]`
 * (ATO-1043, ATO-15).
 *
 * `recommend` says what this machine has and names three models for it:
 * fast, balanced, quality. `upgrade` decides whether the quality one is
 * worth fetching over the active model and, if so, starts it as a
 * background download (the detached worker `models pull --background`
 * uses), so it keeps going after the terminal or the TUI closes. It
 * never switches the model: the switch is offered by whoever shows the
 * progress (the desktop bar, the TUI), once the weights are on disk.
 *
 * The desktop reads `--json` of both. Their shape is a contract: fields
 * are only ever added.
 */

import {
  modelDownloadGb,
  type ModelUpgradeDecision,
} from "../local-llm/catalog/model-upgrade.js";
import type { LocalModelDef } from "../local-llm/index.js";
import {
  readRecommendSnapshot,
  startModelUpgrade,
  type RecommendSnapshot,
} from "../local-llm/model-upgrade-runner.js";

export { readRecommendSnapshot, startModelUpgrade, type RecommendSnapshot };

/** Bumped only on a breaking change; additions keep it. */
export const RECOMMEND_JSON_VERSION = 1;

interface ModelJson {
  id: string;
  name: string;
  sizeLabel: string;
  downloadGb: number;
  description: string;
  supportsVision: boolean;
}

function modelJson(def: LocalModelDef | null): ModelJson | null {
  if (!def) return null;
  return {
    id: def.id,
    name: def.name,
    sizeLabel: def.sizeLabel,
    downloadGb: Math.round(modelDownloadGb(def) * 100) / 100,
    description: def.description,
    supportsVision: def.supportsVision === true,
  };
}

export function recommendJson(snap: RecommendSnapshot): Record<string, unknown> {
  const d = snap.decision;
  return {
    version: RECOMMEND_JSON_VERSION,
    machine: {
      ramGb: snap.machine.ramGb,
      gpuBudgetGb: round1(snap.machine.gpuBudgetGb),
      freeDiskGb: round1(snap.machine.freeDiskGb),
      cpuOnly: snap.machine.cpuOnly,
    },
    tiers: {
      fast: modelJson(snap.tiers.fast),
      balanced: modelJson(snap.tiers.balanced),
      quality: modelJson(snap.tiers.quality),
    },
    activeModelId: snap.activeModelId,
    upgrade:
      d.action === "none"
        ? { action: "none", why: d.why, model: null }
        : { action: d.action, why: null, model: modelJson(d.model) },
  };
}

function round1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

/** `models recommend [--json]`. */
export async function runModelsRecommend(args: readonly string[]): Promise<number> {
  const snap = await readRecommendSnapshot();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(recommendJson(snap))}\n`);
    return 0;
  }
  process.stdout.write(describeRecommendation(snap));
  return 0;
}

export function describeRecommendation(snap: RecommendSnapshot): string {
  const m = snap.machine;
  const gpu = m.cpuOnly
    ? "no GPU (runs on the CPU)"
    : m.gpuBudgetGb === null
      ? "GPU memory unknown"
      : `${m.gpuBudgetGb.toFixed(1)} GB for the model on the GPU`;
  const disk = m.freeDiskGb === null ? "free disk unknown" : `${m.freeDiskGb.toFixed(0)} GB free on disk`;
  const lines = [`this machine: ${m.ramGb} GB RAM, ${gpu}, ${disk}`, ""];
  const row = (label: string, def: LocalModelDef | null) =>
    `  ${label.padEnd(9)} ${def ? `${def.id.padEnd(20)} ${def.sizeLabel.padEnd(8)} ${def.description}` : "none fits this machine"}`;
  lines.push(
    row("fast", snap.tiers.fast),
    row("balanced", snap.tiers.balanced),
    row("quality", snap.tiers.quality),
    "",
  );
  const d = snap.decision;
  if (d.action === "download") {
    lines.push(`upgrade: ${d.model.id} is better than what runs now — 'atomic-agent models upgrade' fetches it in the background`);
  } else if (d.action === "switch") {
    lines.push(`upgrade: ${d.model.id} is already on disk — 'atomic-agent models use ${d.model.id}' switches to it`);
  } else {
    lines.push(`upgrade: none (${NONE_WORDS[d.why]})`);
  }
  return `${lines.join("\n")}\n`;
}

const NONE_WORDS: Record<Extract<ModelUpgradeDecision, { action: "none" }>["why"], string> = {
  already_best: "the active model is already the best this machine carries",
  nothing_fits: "no catalog model runs comfortably here",
  not_managed: "local models are served by your own server, not the built-in engine",
  not_wanted: "a cloud model is active",
  own_choice: "the active model is one you added yourself",
};

/**
 * `models upgrade [--json] [--dry-run]`: start the background download
 * of the big model when the decision says so. Exit 0 whether or not
 * there was anything to do; the JSON says which.
 */
export async function runModelsUpgrade(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const { snapshot: snap, job } = await startModelUpgrade({ dryRun });
  const out = recommendJson(snap);
  const d = snap.decision;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...out, job })}\n`);
    return 0;
  }
  if (d.action === "download") {
    process.stdout.write(
      dryRun
        ? `would download ${d.model.id} (${d.model.sizeLabel}) in the background\n`
        : `${job?.started ? "downloading" : "already downloading"} ${d.model.id} (${d.model.sizeLabel}) in the background\n` +
            `  progress: atomic-agent models downloads\n` +
            `  when done: atomic-agent models use ${d.model.id}\n`,
    );
  } else if (d.action === "switch") {
    process.stdout.write(`${d.model.id} is already on disk — 'atomic-agent models use ${d.model.id}' switches to it\n`);
  } else {
    process.stdout.write(`nothing to upgrade: ${NONE_WORDS[d.why]}\n`);
  }
  return 0;
}
