/**
 * Whether a GGUF sitting in a Hugging Face repo could run under this
 * agent at all — the "fits at least in theory" gate on the first-run
 * picker. Pure string and arithmetic work so the verdicts can be tested
 * as a table; nothing here touches the network or the filesystem.
 *
 * The judgement is deliberately conservative in one direction only: a
 * file is rejected when it is positively identified as something
 * llama-server cannot serve on its own, and accepted otherwise. An
 * unrecognised naming scheme is a reason to let the operator try, not a
 * reason to hide the file.
 */

export type GgufVerdict =
  | "usable"
  /** An `mmproj-*.gguf` vision projector — an accessory, not weights. */
  | "projector"
  /** One part of a `-00001-of-000NN` set; the downloader fetches one file. */
  | "sharded"
  /** A speculative-decoding (MTP/NextN) companion, not a servable model. */
  | "companion"
  /** F16/F32/BF16 weights: a conversion step, not a quantisation. */
  | "unquantised";

export interface GgufJudgement {
  verdict: GgufVerdict;
  /** Shown verbatim when this file is the one the operator asked for. */
  reason: string | null;
}

export function isMmprojFile(path: string): boolean {
  return /(^|\/)mmproj[^/]*\.gguf$/i.test(path);
}

/**
 * Multi-part GGUFs are named `…-00001-of-00003.gguf`. The installer
 * fetches exactly one file, so any shard — the first included — yields a
 * model that cannot load. Serving them means fetching the whole set.
 */
export function isShardedGguf(path: string): boolean {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(path);
}

/**
 * MTP/NextN companions are GGUFs but not runnable models, and they are
 * small, so a size-based fallback would happily pick one when a repo
 * ships nothing else recognisable.
 */
export function isMtpCompanionFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /(^|\/)mtp\//i.test(path) || /(^|[-_.])mtp([-_.]|\.gguf$)/i.test(name);
}

/**
 * Full-precision weights. Repos that ship quants almost always ship the
 * F16 they were quantised from next to them, and it is several times the
 * size of anything the operator wants on a first run.
 */
export function isFullPrecisionGguf(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /(^|[-_.])(?:f16|f32|bf16|fp16|fp32)(?=[-_.]|\.gguf$)/i.test(name);
}

export function judgeGgufFile(path: string): GgufJudgement {
  if (!/\.gguf$/i.test(path)) {
    return { verdict: "unquantised", reason: `${path} is not a .gguf file` };
  }
  if (isMmprojFile(path)) {
    return {
      verdict: "projector",
      reason:
        "that is a vision projector, not model weights — name the repo instead " +
        "and the projector is picked up with it",
    };
  }
  if (isShardedGguf(path)) {
    return {
      verdict: "sharded",
      reason:
        "that is one part of a multi-part model; only the part would be " +
        "downloaded and it would not load. Pick a single-file quant.",
    };
  }
  if (isMtpCompanionFile(path)) {
    return {
      verdict: "companion",
      reason:
        "that looks like a speculative-decoding companion (MTP/NextN), not " +
        "runnable weights — pick the main GGUF.",
    };
  }
  if (isFullPrecisionGguf(path)) {
    return {
      verdict: "unquantised",
      reason:
        "that is the full-precision conversion, not a quantisation — pick a " +
        "Q4/Q5/Q8 file from the same repo.",
    };
  }
  return { verdict: "usable", reason: null };
}

/** Plural-aware tally of what was filtered out, or `null` when nothing was. */
export function describeRejectedGgufFiles(
  verdicts: readonly GgufVerdict[],
): string | null {
  const labels: Record<Exclude<GgufVerdict, "usable">, string> = {
    projector: "vision projector",
    sharded: "multi-part",
    companion: "speculative-decoding companion",
    unquantised: "full-precision",
  };
  const counts = new Map<string, number>();
  for (const verdict of verdicts) {
    if (verdict === "usable") continue;
    const label = labels[verdict];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const parts = [...counts].map(([label, n]) => `${n} ${label}`);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return `${total} more file${total === 1 ? "" : "s"} hidden: ${parts.join(", ")}`;
}

/**
 * Weights bigger than physical RAM still start — llama.cpp memory-maps
 * the file and the OS pages it in — they are just slow enough that
 * saying so is worth a line. This warns; nothing acts on it.
 *
 * Kept to one short line on purpose: it is drawn inside a step with a
 * fixed row budget, and Ink 7 overlaps the rows above rather than
 * clipping, so a wrap here would paint over the file list.
 */
export function ramWarningFor(fileSizeGb: number, hostRamGb: number): string | null {
  if (fileSizeGb <= 0 || hostRamGb <= 0) return null;
  if (fileSizeGb <= hostRamGb) return null;
  return (
    `${fileSizeGb.toFixed(1)} GB model, ${hostRamGb} GB of RAM — ` +
    `it will run from disk, slowly.`
  );
}
