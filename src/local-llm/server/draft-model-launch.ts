import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolveChatModelWeightsPath } from "../backend-paths.js";
import { readGgufMetadataSync, kvLayoutSourceFromMetadata, type GgufMetadata } from "../catalog/gguf-metadata.js";
import { getLocalModelDef, isKnownLocalModelId } from "../catalog/models-catalog.js";
import { buildKvLayout, estimateLaunchKvBytes } from "./context-size.js";
import {
  decideDraftLaunch,
  draftFlagsMissing,
  draftVocabProblem,
  resolveDraftCandidate,
  type DraftLaunchDecision,
  type DraftModelPreference,
} from "./draft-model.js";

/**
 * The file side of `decideDraftLaunch` for one `startDaemon` (ATO-2424):
 * finds the draft, reads its header, sizes its cache at the fitted window
 * and, when the draft is going on, checks the engine's `--help` lists the
 * draft flags. Synchronous, like the rest of the launch's reads (the
 * health wait's timers are faked in tests). `null`: `draftModel` is
 * `"off"`, the launch is unchanged and logs nothing.
 */
export function resolveDraftLaunch(input: {
  dataDir: string;
  preference: DraftModelPreference | undefined;
  model: { id: string; draftModelId?: string };
  engine: "llama-server" | "atomic-core";
  device: string | undefined;
  binPath: string;
  targetHeader: GgufMetadata | null;
  contextSize: number;
  kvBudgetBytes: number | null;
  mainKvBytes: number;
  pinnedDevice: string | null;
  /** Test seams; the defaults read the disk and run the engine. */
  readHeader?: (path: string) => GgufMetadata | null;
  readHelp?: (binPath: string) => string;
}): DraftLaunchDecision | null {
  const resolved = resolveDraftCandidate(input.preference, input.model, {
    lookup: (id) => {
      if (!isKnownLocalModelId(id)) return { known: false, path: null, sizeBytes: 0 };
      const path = resolveChatModelWeightsPath(input.dataDir, getLocalModelDef(id));
      const size = fileSize(path);
      return { known: true, path: size === null ? null : path, sizeBytes: size ?? 0 };
    },
    statFile: fileSize,
  });
  if (resolved === null) return null;
  if ("skip" in resolved) return { args: [], reason: `draft: off (${resolved.skip})` };
  const { candidate } = resolved;
  const header = (input.readHeader ?? readHeaderQuiet)(candidate.path);
  const layout = header ? kvLayoutSourceFromMetadata(header) : null;
  const decision = decideDraftLaunch({
    candidate,
    explicit: input.preference !== "auto",
    engine: input.engine,
    device: input.device,
    targetRecurrent: input.targetHeader?.hasRecurrentState === true || header?.hasRecurrentState === true,
    vocabProblem: input.targetHeader && header ? draftVocabProblem(input.targetHeader, header) : null,
    contextSize: input.contextSize,
    kvBudgetBytes: input.kvBudgetBytes,
    mainKvBytes: input.mainKvBytes,
    draftKvBytes: estimateLaunchKvBytes({
      kvLayout: layout ? buildKvLayout(layout) : null,
      modelSizeGb: candidate.sizeBytes / 1e9,
      contextSize: input.contextSize,
      cacheType: "f16",
    }),
    pinnedDevice: input.pinnedDevice,
  });
  if (decision.args.length === 0) return decision;
  let help: string;
  try {
    help = (input.readHelp ?? readHelp)(input.binPath);
  } catch {
    help = "";
  }
  const missing = draftFlagsMissing(decision.args, help);
  if (missing.length > 0) {
    return { args: [], reason: `draft: off (this engine build does not list ${missing.join(", ")})` };
  }
  return decision;
}

function fileSize(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function readHeaderQuiet(path: string): GgufMetadata | null {
  try {
    return readGgufMetadataSync(path);
  } catch {
    return null;
  }
}

/** `llama-server --help`; its text comes back on a non-zero exit too. */
function readHelp(binPath: string): string {
  try {
    return execFileSync(binPath, ["--help"], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    return `${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`;
  }
}
