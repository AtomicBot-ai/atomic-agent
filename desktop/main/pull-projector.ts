/**
 * ATO-1331: a catalogue vision model's projector, in the one `models pull`.
 *
 * `atag models pull <id>` brings the weights alone unless told `--mmproj`, and
 * `models start` attaches a projector only when its file is on disk. Every
 * catalogue pull goes through startModelPull (main.ts), so that is where this
 * is decided: a new caller cannot forget it. Models added from Hugging Face
 * are not in the catalogue and keep their own step (cli:hfProjector).
 */
import { readdirSync } from "node:fs";

import { isMmprojFile } from "./huggingface.js";
import { curatedMeta } from "./model-catalog.js";

export function catalogPullWantsProjector(id: string): boolean {
  return curatedMeta(id)?.vision === true;
}

export interface PullProgress {
  kind?: string;
  percent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  label?: string;
}

const GIB = 1024 * 1024 * 1024;
/** The line src/cli/models-handlers.ts prints between the weights and the projector. */
const PROJECTOR_PHASE = "downloading mmproj ";

/**
 * One pull, one bar. The agent reports the weights and then the projector,
 * each from 0 to 100, and the bar would otherwise reach the end and fall back
 * to nothing. This puts both on the size the catalogue promised. Sizes are the
 * catalogue's, in GiB as the agent's own estimate reads them.
 *
 * ATO-1369: `weightsHere` is a pull whose weights are already on disk. The
 * agent skips them without a progress line and fetches the projector alone,
 * so the bar is the projector's size: it starts near 0%, not at ~85%, and
 * shows the projector's GB, not the weights' nobody is downloading.
 */
export function wholePullProgress(id: string, weightsHere = false): (line: string, progress: PullProgress) => PullProgress {
  const meta = curatedMeta(id);
  const weights = weightsHere ? 0 : (meta?.sizeGb ?? 0) * GIB;
  const projector = (meta?.mmprojSizeGb ?? 0) * GIB;
  if (!projector || (!weights && !weightsHere)) return (_line, progress) => progress;
  const total = weights + projector;
  let onProjector = false;
  return (line, progress) => {
    if (line.startsWith(PROJECTOR_PHASE)) onProjector = true;
    if (typeof progress.percent !== "number") return progress;
    const share = progress.percent / 100;
    const done = onProjector ? weights + share * projector : share * weights;
    const percent = Math.min(100, Math.round((done / total) * 100));
    if (typeof progress.transferredBytes !== "number") return { ...progress, percent };
    const transferredBytes = Math.min(total, (onProjector ? weights : 0) + progress.transferredBytes);
    return { ...progress, percent, transferredBytes, totalBytes: Math.round(total) };
  };
}

/**
 * ATO-1369: a model's folder holds finished weights: a `.gguf` that is not a
 * projector. A `.part` file does not count, so a resumed pull keeps the whole bar.
 */
export function weightsOnDisk(modelDir: string): boolean {
  try {
    return readdirSync(modelDir).some((f) => /\.gguf$/i.test(f) && !isMmprojFile(f));
  } catch {
    return false;
  }
}

/** A model's folder holds a finished projector; a `.part` file does not count. */
export function projectorOnDisk(modelDir: string): boolean {
  try {
    return readdirSync(modelDir).some(isMmprojFile);
  } catch {
    return false;
  }
}

/**
 * A pull in flight has its weights on disk while its projector is still a
 * `.part`: that is a download under way, not a projector missing.
 */
export function withoutLivePullGap<R extends { models?: Array<{ id: string; projectorMissing?: boolean }> }>(list: R, pullingId: string | null): R {
  if (!pullingId || !list.models) return list;
  return {
    ...list,
    models: list.models.map((m) => {
      if (m.id !== pullingId || !m.projectorMissing) return m;
      const { projectorMissing: _inFlight, ...settled } = m;
      return settled;
    }),
  } as R;
}
