/**
 * `model_download_started` / `model_download_finished`, `hf_lookup` and
 * `llama_runtime_updated`. What a download is (curated or Hugging Face,
 * its size, quant, projector, fit) is looked up here from the vendored
 * catalogue or the config's customModels entry — never from the renderer,
 * and never a repo or file name: the quant is parsed down to its enum-like
 * tag and everything else is a number or a boolean.
 */

import { totalmem } from "node:os";

import { curatedMeta } from "../model-catalog.js";
import { DOWNLOAD_TRIGGERS } from "./catalog.js";
import { downloadFailReason, fitFor, hfLookupResult, quantOf } from "./classify.js";
import { readConfigFile } from "./environment.js";
import { track } from "./core.js";

interface Download {
  id: string;
  startedAt: number;
  props: Record<string, unknown>;
  maxPercent: number;
  maxBytes: number;
  cancelled: boolean;
}

let current: Download | null = null;
let stateDir = "";
let ramGb: () => number = () => Math.round(totalmem() / 1024 ** 3);

export function configureDownloads(opts: { stateDir: string; hostRamGb?: () => number }): void {
  stateDir = opts.stateDir;
  if (opts.hostRamGb) ramGb = opts.hostRamGb;
}

function customDef(id: string): Record<string, unknown> | null {
  try {
    const cfg = readConfigFile(stateDir);
    const lm = cfg && typeof cfg === "object" ? (cfg["localModels"] as Record<string, unknown> | undefined) : undefined;
    const list = lm?.["customModels"];
    if (!Array.isArray(list)) return null;
    const hit = list.find((m) => m && typeof m === "object" && (m as { id?: unknown }).id === id);
    return (hit as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

const numOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The started-event's properties for a model id. */
export function describeModel(id: string, trigger: unknown): Record<string, unknown> {
  const t = typeof trigger === "string" && (DOWNLOAD_TRIGGERS as readonly string[]).includes(trigger) ? trigger : "other";
  const host = ramGb();
  const meta = curatedMeta(id);
  if (meta) {
    return {
      model_id: id,
      source: "curated",
      size_gb: meta.sizeGb,
      quant: "unknown",
      has_projector: meta.mmprojSizeGb !== undefined,
      fit: fitFor(host, meta),
      trigger: t,
    };
  }
  const def = customDef(id);
  const size = numOr(def?.["fileSizeGb"]);
  return {
    model_id: "hf_custom",
    source: "hf",
    size_gb: size,
    quant: quantOf(def?.["filename"]),
    has_projector: typeof def?.["mmprojFilename"] === "string",
    fit: fitFor(host, { sizeGb: size, minRamGb: numOr(def?.["minRamGb"]), recommendedRamGb: numOr(def?.["recommendedRamGb"]) }),
    trigger: t,
  };
}

/** `cli:modelsPull` took the slot. */
export function downloadStarted(id: string, trigger?: unknown): void {
  try {
    const props = describeModel(id, trigger);
    current = { id, startedAt: Date.now(), props, maxPercent: 0, maxBytes: 0, cancelled: false };
    track("model_download_started", props);
  } catch {
    current = null;
  }
}

/** A progress frame of the weights download. */
export function downloadProgress(id: string, p: { percent?: number; transferredBytes?: number }): void {
  if (!current || current.id !== id) return;
  if (typeof p.percent === "number" && p.percent > current.maxPercent) current.maxPercent = p.percent;
  if (typeof p.transferredBytes === "number" && p.transferredBytes > current.maxBytes) current.maxBytes = p.transferredBytes;
}

/** Cancel was pressed for the weights download in the slot. */
export function downloadCancelRequested(): void {
  if (current) current.cancelled = true;
}

/** The pull's `done`. */
export function downloadFinished(id: string, res: { ok?: boolean; error?: string | null }): void {
  try {
    const d = current && current.id === id ? current : null;
    current = null;
    if (!d) return;
    const ms = Date.now() - d.startedAt;
    const ok = res.ok === true;
    const result = ok ? "ok" : d.cancelled ? "cancelled" : "failed";
    const secs = ms / 1000;
    const bytes = d.maxBytes || (ok && typeof d.props.size_gb === "number" ? d.props.size_gb * 1024 ** 3 : 0);
    track("model_download_finished", {
      ...d.props,
      result,
      reason: result === "failed" ? downloadFailReason(res.error, d.maxPercent > 0 || d.maxBytes > 0) : null,
      ms,
      // megabits per second, over the whole download
      avg_mbps: bytes > 0 && secs > 0 ? (bytes * 8) / 1e6 / secs : null,
      percent_reached: ok ? 100 : Math.round(d.maxPercent),
    });
  } catch {
    /* never */
  }
}

/** A pull refused before it started because another download holds the slot. */
export function downloadRefusedBusy(id: string, trigger?: unknown): void {
  try {
    track("model_download_finished", {
      ...describeModel(id, trigger),
      result: "failed",
      reason: "busy",
      ms: 0,
      avg_mbps: null,
      percent_reached: 0,
    });
  } catch {
    /* never */
  }
}

/** `cli:hfResolve`'s answer. Cancelled lookups are not reported. */
export function hfLookupDone(outcome: { choices?: number; error?: string }): void {
  try {
    if (typeof outcome.error === "string") track("hf_lookup", { result: hfLookupResult(outcome.error), choices_count: 0 });
    else track("hf_lookup", { result: "ok", choices_count: outcome.choices ?? 0 });
  } catch {
    /* never */
  }
}

/** `models update` finished — the setup's streamed phase or Settings' button. */
export function runtimeUpdated(
  trigger: "setup" | "settings",
  startedAt: number,
  res: { ok?: boolean; upToDate?: boolean; error?: string | null } | null,
  cancelled: boolean,
): void {
  try {
    const result = cancelled ? "cancelled" : res?.ok ? (res.upToDate ? "up_to_date" : "ok") : "failed";
    track("llama_runtime_updated", { trigger, result, ms: Date.now() - startedAt });
  } catch {
    /* never */
  }
}
