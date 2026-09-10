import {
  resolveModelFilePath,
  resolveMmprojFilePath,
} from "./backend-paths.js";
import { readPartialDownload } from "./download-file.js";
import {
  DOWNLOAD_JOB_VERSION,
  downloadJobId,
  type DownloadJob,
  type DownloadJobKind,
  type DownloadJobMode,
} from "./download-jobs.js";
import { isMmprojDownloaded, isModelDownloaded } from "./model-installer.js";
import {
  getEmbeddingModelDef,
  getLocalModelDef,
  type EmbeddingModelId,
  type LocalModelId,
} from "./models-catalog.js";

/**
 * Seed the record a spawner writes the instant the worker is launched,
 * so `models downloads` lists the job before the worker has opened its
 * first socket. The worker overwrites it with real numbers as soon as
 * they exist. The partial already on disk (if any) is reported from
 * the start, so a resumed job never shows 0% even for a moment.
 */
export function initialDownloadJob(input: {
  dataDir: string;
  kind: DownloadJobKind;
  modelId: string;
  mode: DownloadJobMode;
  pid: number;
  now?: Date;
}): DownloadJob {
  const now = (input.now ?? new Date()).toISOString();
  const { label, phase, files } = describeJobFiles(input);
  // A pull that fetches weights and projector together is one job with
  // one bar, so both files count toward it from the first frame.
  let transferred = 0;
  let total = 0;
  for (const file of files) {
    const partial = readPartialDownload(file.dest);
    transferred += partial?.transferred ?? 0;
    total += partial?.total || file.estTotal;
  }
  return {
    version: DOWNLOAD_JOB_VERSION,
    id: downloadJobId(input.kind, input.modelId),
    kind: input.kind,
    modelId: input.modelId,
    mode: input.mode,
    pid: input.pid,
    status: "running",
    phase,
    label,
    percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
    transferredBytes: transferred,
    totalBytes: total,
    error: null,
    waiting: null,
    resumable: false,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

interface JobFile {
  dest: string;
  estTotal: number;
}

function describeJobFiles(input: {
  dataDir: string;
  kind: DownloadJobKind;
  modelId: string;
  mode: DownloadJobMode;
}): { label: string; phase: DownloadJob["phase"]; files: JobFile[] } {
  const gb = (n: number | undefined): number =>
    Math.round((n ?? 0) * 1024 * 1024 * 1024);
  if (input.kind === "embedding") {
    const def = getEmbeddingModelDef(input.modelId as EmbeddingModelId);
    return {
      label: def.name,
      phase: "gguf",
      files: [
        {
          dest: resolveModelFilePath(input.dataDir, def.id, def.filename),
          estTotal: gb(def.fileSizeGb),
        },
      ],
    };
  }
  const def = getLocalModelDef(input.modelId as LocalModelId);
  const gguf: JobFile = {
    dest: resolveModelFilePath(input.dataDir, def.id, def.filename),
    estTotal: gb(def.fileSizeGb),
  };
  const mmproj: JobFile | null = def.mmprojFilename
    ? {
        dest: resolveMmprojFilePath(input.dataDir, def.id, def.mmprojFilename),
        estTotal: gb(def.mmprojFileSizeGb ?? 1),
      }
    : null;
  const needGguf =
    input.mode !== "mmproj-only" && !isModelDownloaded(input.dataDir, def);
  const needMmproj =
    mmproj !== null &&
    (input.mode === "with-mmproj" || input.mode === "mmproj-only") &&
    !isMmprojDownloaded(input.dataDir, def);
  if (needGguf && needMmproj && mmproj) {
    return {
      label: `${def.name} (gguf + mmproj)`,
      phase: "gguf",
      files: [gguf, mmproj],
    };
  }
  if (needMmproj && mmproj) {
    return { label: `${def.name} (mmproj)`, phase: "mmproj", files: [mmproj] };
  }
  return { label: `${def.name} (gguf)`, phase: "gguf", files: [gguf] };
}
