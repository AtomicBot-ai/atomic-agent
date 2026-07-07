import { join } from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "../config/config-file.js";
import type { UserConfigFile } from "../config/config-schema.js";
import {
  checkForBackendUpdate,
  downloadBackend,
  downloadEmbeddingModel,
  downloadModel,
  EMBEDDING_MODELS_CATALOG,
  getDaemonStatus,
  getEmbeddingDaemonStatus,
  getEmbeddingModelDef,
  getLocalModelDef,
  isBackendDownloaded,
  isEmbeddingModelDownloaded,
  isKnownEmbeddingModelId,
  isKnownLocalModelId,
  isMmprojDownloaded,
  isModelDownloaded,
  listVulkanDevices,
  LOCAL_MODELS_CATALOG,
  readBackendVersion,
  removeModel,
  resolveChatTemplatePath,
  resolveManagedDevice,
  resolveMmprojFilePath,
  resolvePlatformAsset,
  resolveServerBinPath,
  startChatAndEmbeddingDaemons,
  stopChatAndEmbeddingDaemons,
} from "../local-llm/index.js";

export function readCliOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function renderPullProgress(
  label: string,
  percent: number,
  transferred: number,
  total: number,
): string {
  const barW = 20;
  const filled = Math.min(barW, Math.round((percent / 100) * barW));
  const bar = `${"=".repeat(filled)}${" ".repeat(barW - filled)}`;
  const tail =
    total > 0
      ? `${formatGb(transferred)} / ${formatGb(total)}`
      : `${formatGb(transferred)}`;
  return `[${bar}] ${percent}%  ${tail}  ${label}`;
}

export async function runLocalModelsList(): Promise<number> {
  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  process.stdout.write(
    "ID                  | FAMILY | SIZE   | CONTEXT | DL  | ACTIVE\n",
  );
  for (const m of LOCAL_MODELS_CATALOG) {
    const dl = isModelDownloaded(dataDir, m) ? "yes" : "no";
    const active =
      cfg.localModels.managed.modelId === m.id && cfg.localModels.mode === "managed" ? "*" : " ";
    process.stdout.write(
      `${m.id.padEnd(19)} | ${m.family.padEnd(6)} | ${m.sizeLabel.padEnd(6)} | ${m.contextLabel.padEnd(7)} | ${dl.padEnd(3)} | ${active}\n`,
    );
  }
  return 0;
}

export async function runLocalModelsPull(idArg: string | undefined): Promise<number> {
  if (!idArg || !isKnownLocalModelId(idArg)) {
    process.stderr.write(
      `unknown model id. Valid: ${LOCAL_MODELS_CATALOG.map((m) => m.id).join(", ")}\n`,
    );
    return 1;
  }
  const m = getLocalModelDef(idArg);
  const dataDir = getConfig().paths.localModelsDataDir;
  const estTotal = Math.round(m.fileSizeGb * (1024 * 1024 * 1024));
  const tty = process.stderr.isTTY;
  let lastLine = "";
  const onProgress = (percent: number, transferred: number, total: number): void => {
    const line = renderPullProgress(
      `${m.filename} (${m.sizeLabel})`,
      percent,
      transferred,
      total > 0 ? total : estTotal,
    );
    if (tty) {
      process.stderr.write(`\r${line.padEnd(79)}`);
    } else if (percent % 5 === 0 || percent === 100) {
      process.stderr.write(`${line}\n`);
    }
    lastLine = line;
  };
  try {
    process.stderr.write(`downloading ${m.id} (${m.filename}, ${m.sizeLabel})\n`);
    await downloadModel(dataDir, m, { onProgress });
    if (tty) process.stderr.write(`\n`);
    else if (lastLine) process.stderr.write(`done: ${lastLine}\n`);
    const savedPath = join(dataDir, "models", m.id, m.filename);
    process.stdout.write(`done. model saved to ${savedPath}\n`);
    return 0;
  } catch (e) {
    if (tty) process.stderr.write(`\n`);
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export async function runLocalModelsUse(idArg: string | undefined): Promise<number> {
  if (!idArg || !isKnownLocalModelId(idArg)) {
    process.stderr.write(
      `unknown model id. Valid: ${LOCAL_MODELS_CATALOG.map((m) => m.id).join(", ")}\n`,
    );
    return 1;
  }
  const cfg = getConfig();
  const path = cfg.paths.userConfigFile;
  const user = ensureUserConfigFileSync(path);
  const st0 = await getDaemonStatus(cfg.paths.localModelsDataDir, cfg.localModels.managed.port);
  const prevModel = user.localModels.managed.modelId;
  const next: UserConfigFile = {
    ...user,
    localModels: {
      ...user.localModels,
      mode: "managed",
      managed: { ...user.localModels.managed, modelId: idArg },
    },
  };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
  const fresh = getConfig();
  if (st0.running && prevModel !== idArg) {
    process.stderr.write(
      "note: daemon is running with old model. Run `atomic-agent models stop && atomic-agent models start` to apply.\n",
    );
  }
  process.stdout.write(
    `mode: managed\nactive model: ${fresh.localModels.managed.modelId}\nurl: ${fresh.localModels.url}\n`,
  );
  return 0;
}

export async function runLocalModelsStatus(): Promise<number> {
  const cfg = getConfig();
  if (cfg.localModels.mode === "external") {
    process.stdout.write(`mode:           external\nurl:            ${cfg.localModels.url}\n`);
    return 0;
  }
  const dataDir = cfg.paths.localModelsDataDir;
  const ver = readBackendVersion(dataDir);
  const binOk = isBackendDownloaded(dataDir);
  const mid = cfg.localModels.managed.modelId;
  let modelLine = "none";
  if (mid && isKnownLocalModelId(mid)) {
    const m = getLocalModelDef(mid);
    const ok = isModelDownloaded(dataDir, m);
    modelLine = `${mid}  ${ok ? "✓ downloaded" : "✗ not downloaded"}`;
  }
  const st = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
  const health = st.healthy ? "ok" : st.loading ? "loading" : "down";
  process.stdout.write(`mode:           managed\n`);
  process.stdout.write(`data dir:       ${dataDir}\n`);
  process.stdout.write(
    `backend:        ${ver?.tag ?? "(none)"} (installed ${ver?.downloadedAt ?? "n/a"}), binary ${binOk ? "ok" : "missing"}\n`,
  );
  process.stdout.write(`active model:   ${modelLine}\n`);
  process.stdout.write(
    `daemon:         ${st.running ? `running (pid ${st.pid})` : "stopped"}  ${cfg.localModels.url}\n`,
  );
  process.stdout.write(`health:         ${health}\n`);
  return 0;
}

export async function runLocalModelsStart(): Promise<number> {
  const cfg = getConfig();
  if (cfg.localModels.mode !== "managed") {
    process.stderr.write("external mode — nothing to start\n");
    return 1;
  }
  const mid = cfg.localModels.managed.modelId;
  if (!mid || !isKnownLocalModelId(mid)) {
    process.stderr.write(
      "pick a model first: atomic-agent models pull <id> && atomic-agent models use <id>\n",
    );
    return 1;
  }
  const dataDir = cfg.paths.localModelsDataDir;
  const m = getLocalModelDef(mid);
  const tpl = resolveChatTemplatePath(m) ?? undefined;
  const mmprojFile =
    cfg.vision.enabled && m.supportsVision && m.mmprojFilename && isMmprojDownloaded(dataDir, m)
      ? resolveMmprojFilePath(dataDir, m.id, m.mmprojFilename)
      : undefined;

  // Memory-v2 phase 1B. Decide whether to also bring the embedding
  // daemon up. Atomicity contract: chat daemon is primary; embedding
  // failure is non-fatal and surfaced as a warning so the runtime
  // gracefully falls back to FTS5-only recall.
  const embCfg = cfg.localModels.embeddings;
  const embRequested =
    embCfg.enabled &&
    embCfg.modelId !== null &&
    isKnownEmbeddingModelId(embCfg.modelId);
  let embReady = false;
  if (embRequested) {
    const embModel = getEmbeddingModelDef(embCfg.modelId as never);
    embReady = isEmbeddingModelDownloaded(dataDir, embModel);
    if (!embReady) {
      process.stderr.write(
        `note: embedding model ${embCfg.modelId} not downloaded — skipping embedding daemon\n` +
          `      run 'atomic-agent models pull-embedding ${embCfg.modelId}' to enable hybrid recall.\n`,
      );
    }
  }

  // Resolve the GPU preference once so both daemons land on the same
  // device and we can name the chosen device in the start output.
  const { binaryName } = resolvePlatformAsset();
  const binPath = resolveServerBinPath(dataDir, binaryName);
  const device = await resolveManagedDevice(binPath, cfg.localModels.managed.device);
  process.stdout.write(
    `device:         ${describeDeviceChoice(cfg.localModels.managed.device, device)}\n`,
  );

  try {
    const result = await startChatAndEmbeddingDaemons({
      chat: {
        dataDir,
        modelId: mid,
        port: cfg.localModels.managed.port,
        contextSize: cfg.localModels.managed.contextSize,
        ...(tpl ? { chatTemplateFile: tpl } : {}),
        ...(mmprojFile ? { mmprojFile } : {}),
        ...(device ? { device } : {}),
      },
      ...(embRequested && embReady
        ? {
            embedding: {
              dataDir,
              modelId: embCfg.modelId as never,
              port: embCfg.port,
              ...(device ? { device } : {}),
            },
          }
        : {}),
    });
    const visionLine = mmprojFile
      ? `, vision enabled (${m.mmprojFilename})`
      : m.supportsVision
        ? `, vision disabled (mmproj missing — download via TUI 'Local Models' panel)`
        : "";
    process.stdout.write(
      `chat: started pid ${result.chat.pid}, healthy on port ${cfg.localModels.managed.port}${visionLine}\n`,
    );
    if ("pid" in result.embedding) {
      process.stdout.write(
        `embedding: started pid ${result.embedding.pid}, healthy on port ${embCfg.port} (${embCfg.modelId})\n`,
      );
    } else if ("error" in result.embedding) {
      process.stderr.write(
        `embedding: failed to start (${result.embedding.error}) — hybrid recall disabled, FTS5 still works\n`,
      );
    } else {
      // skipped — either feature disabled or model missing
      if (!embCfg.enabled) {
        process.stdout.write(
          "embedding: disabled (set localModels.embeddings.enabled = true in config.json to opt in)\n",
        );
      }
    }
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export async function runLocalModelsStop(): Promise<number> {
  try {
    await stopChatAndEmbeddingDaemons(getConfig().paths.localModelsDataDir);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  process.stdout.write("stopped\n");
  return 0;
}

/**
 * Human-readable summary of how the configured device preference
 * resolved at start. `configured` is the raw config value (`auto` /
 * `cpu` / a device id); `resolved` is what `resolveManagedDevice`
 * returned (`undefined` means no GPU was picked → llama.cpp default /
 * CPU fallback).
 */
function describeDeviceChoice(
  configured: string,
  resolved: string | undefined,
): string {
  if (configured === "cpu") return "cpu (forced, -ngl 0)";
  if (configured === "auto") {
    return resolved ? `auto → ${resolved}` : "auto → CPU (no GPU detected)";
  }
  return resolved ?? configured;
}

const DEVICE_ID_RE = /^[A-Za-z]+\d+$/;

/**
 * List compute devices reported by `llama-server --list-devices`. The
 * device the current config would offload to is marked with `*`.
 */
export async function runLocalModelsDevices(): Promise<number> {
  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  if (!isBackendDownloaded(dataDir)) {
    process.stderr.write(
      "backend not downloaded; run 'atomic-agent models update' first\n",
    );
    return 1;
  }
  const { binaryName } = resolvePlatformAsset();
  const binPath = resolveServerBinPath(dataDir, binaryName);
  const configured = cfg.localModels.managed.device;
  const devices = await listVulkanDevices(binPath);
  const resolved = await resolveManagedDevice(binPath, configured);

  process.stdout.write(`configured device: ${configured}\n`);
  process.stdout.write(
    `effective device:  ${describeDeviceChoice(configured, resolved)}\n\n`,
  );
  if (devices.length === 0) {
    process.stdout.write(
      "no GPU devices reported (will run on CPU). Install a Vulkan driver for GPU acceleration.\n",
    );
    return 0;
  }
  process.stdout.write("ID         | VRAM        | DEVICE\n");
  for (const d of devices) {
    const active = d.id === resolved ? "*" : " ";
    const vram = d.totalMemMiB > 0 ? `${d.totalMemMiB} MiB` : "n/a";
    process.stdout.write(
      `${active} ${d.id.padEnd(8)} | ${vram.padEnd(11)} | ${d.description}\n`,
    );
  }
  return 0;
}

/**
 * Set the managed daemon's device preference (`auto` / `cpu` / a device
 * id like `Vulkan0`). Persists to `config.json`; the operator restarts
 * the daemon to apply.
 */
export async function runLocalModelsUseDevice(
  arg: string | undefined,
): Promise<number> {
  const value = arg?.trim();
  if (!value) {
    process.stderr.write(
      "usage: atomic-agent models use-device <auto|cpu|Vulkan0>\n",
    );
    return 1;
  }
  if (value !== "auto" && value !== "cpu" && !DEVICE_ID_RE.test(value)) {
    process.stderr.write(
      `invalid device ${JSON.stringify(value)}. Expected 'auto', 'cpu', or a device id ` +
        "(e.g. Vulkan0 — see 'atomic-agent models devices').\n",
    );
    return 1;
  }
  const cfg = getConfig();
  const path = cfg.paths.userConfigFile;
  const user = ensureUserConfigFileSync(path);
  const next: UserConfigFile = {
    ...user,
    localModels: {
      ...user.localModels,
      managed: { ...user.localModels.managed, device: value },
    },
  };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
  process.stdout.write(
    `device set to ${value}. run 'atomic-agent models start' (or restart) to apply.\n`,
  );
  return 0;
}

/**
 * Memory-v2 phase 1B. Download an embedding GGUF from
 * `EMBEDDING_MODELS_CATALOG`. Mirrors `runLocalModelsPull` but bound
 * to the typed `EmbeddingModelId` union so the wrong catalog can't
 * be hit by accident.
 */
export async function runLocalModelsPullEmbedding(
  idArg: string | undefined,
): Promise<number> {
  if (!idArg || !isKnownEmbeddingModelId(idArg)) {
    process.stderr.write(
      `unknown embedding model id. Valid: ${EMBEDDING_MODELS_CATALOG.map((m) => m.id).join(", ")}\n`,
    );
    return 1;
  }
  const m = getEmbeddingModelDef(idArg);
  const dataDir = getConfig().paths.localModelsDataDir;
  const estTotal = Math.round(m.fileSizeGb * (1024 * 1024 * 1024));
  const tty = process.stderr.isTTY;
  let lastLine = "";
  const onProgress = (
    percent: number,
    transferred: number,
    total: number,
  ): void => {
    const line = renderPullProgress(
      `${m.filename} (${m.sizeLabel})`,
      percent,
      transferred,
      total > 0 ? total : estTotal,
    );
    if (tty) process.stderr.write(`\r${line.padEnd(79)}`);
    else if (percent % 5 === 0 || percent === 100)
      process.stderr.write(`${line}\n`);
    lastLine = line;
  };
  try {
    process.stderr.write(
      `downloading embedding model ${m.id} (${m.filename}, ${m.sizeLabel})\n`,
    );
    await downloadEmbeddingModel(dataDir, m, { onProgress });
    if (tty) process.stderr.write(`\n`);
    else if (lastLine) process.stderr.write(`done: ${lastLine}\n`);
    const savedPath = join(dataDir, "models", m.id, m.filename);
    process.stdout.write(`done. embedding model saved to ${savedPath}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(
      `${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}

/**
 * Memory-v2 phase 1B. Enable/disable the embedding daemon and select
 * its model. Writes through to `<stateDir>/config.json` so the choice
 * survives restarts. Does not start/stop the daemon — operator runs
 * `atomic-agent models start` afterwards.
 *
 * Usage:
 *   atomic-agent models use-embedding <id>      # enable + select
 *   atomic-agent models use-embedding --disable # turn off
 */
export async function runLocalModelsUseEmbedding(
  arg: string | undefined,
): Promise<number> {
  const cfg = getConfig();
  const existing = (ensureUserConfigFileSync(
    cfg.paths.userConfigFile,
  )) as UserConfigFile;
  if (arg === "--disable" || arg === "off") {
    const next: UserConfigFile = {
      ...existing,
      localModels: {
        ...existing.localModels,
        embeddings: {
          ...existing.localModels.embeddings,
          enabled: false,
        },
      },
    };
    writeUserConfigFileSync(cfg.paths.userConfigFile, next);
    resetConfigCache();
    process.stdout.write(
      "embedding daemon disabled. run 'atomic-agent models start' to apply.\n",
    );
    return 0;
  }
  if (!arg || !isKnownEmbeddingModelId(arg)) {
    process.stderr.write(
      `unknown embedding model id. Valid: ${EMBEDDING_MODELS_CATALOG.map(
        (m) => m.id,
      ).join(", ")}\n` +
        `       (or pass --disable to turn the embedding daemon off)\n`,
    );
    return 1;
  }
  const next: UserConfigFile = {
    ...existing,
    localModels: {
      ...existing.localModels,
      embeddings: {
        ...existing.localModels.embeddings,
        enabled: true,
        modelId: arg,
      },
    },
  };
  writeUserConfigFileSync(cfg.paths.userConfigFile, next);
  resetConfigCache();
  process.stdout.write(
    `embedding model set to ${arg}. run 'atomic-agent models start' to apply.\n`,
  );
  return 0;
}

/**
 * Memory-v2 phase 1B. List embedding models in the catalog with
 * download / enabled / active status. Mirrors `runLocalModelsList`
 * with the embedding-specific columns.
 */
export async function runLocalModelsListEmbeddings(): Promise<number> {
  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  process.stdout.write(
    "ID                       | SIZE   | DIM | POOLING | DL  | ACTIVE\n",
  );
  for (const m of EMBEDDING_MODELS_CATALOG) {
    const dl = isEmbeddingModelDownloaded(dataDir, m) ? "yes" : "no";
    const active =
      cfg.localModels.embeddings.modelId === m.id &&
      cfg.localModels.embeddings.enabled
        ? "*"
        : " ";
    process.stdout.write(
      `${m.id.padEnd(24)} | ${m.sizeLabel.padEnd(6)} | ${String(m.dim).padEnd(3)} | ${m.pooling.padEnd(7)} | ${dl.padEnd(3)} | ${active}\n`,
    );
  }
  // Surface daemon status too — operators expect a single command to
  // confirm "is the embedding daemon up?" without an extra round-trip.
  const embPort = cfg.localModels.embeddings.port;
  const st = await getEmbeddingDaemonStatus(dataDir, embPort);
  process.stdout.write(
    `\nembedding daemon: ${st.running ? `running (pid ${st.pid})` : "stopped"} on port ${embPort}, health: ${
      st.healthy ? "ok" : st.loading ? "loading" : "down"
    }\n`,
  );
  return 0;
}

export async function runLocalModelsUpdate(): Promise<number> {
  const cfg = getConfig();
  if (cfg.localModels.mode !== "managed") {
    process.stderr.write("switch to managed mode first (atomic-agent models use <id>)\n");
    return 1;
  }
  const dataDir = cfg.paths.localModelsDataDir;
  try {
    const { updateAvailable, latestTag, currentTag } = await checkForBackendUpdate(dataDir);
    if (!updateAvailable) {
      process.stdout.write(`backend up to date (${latestTag})\n`);
      return 0;
    }
    process.stdout.write(`current: ${currentTag ?? "none"} → latest: ${latestTag}\n`);
    const st = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (st.running) await stopChatAndEmbeddingDaemons(dataDir);
    const tty = process.stderr.isTTY;
    await downloadBackend(dataDir, {
      onProgress: (p, t, tot) => {
        const line = renderPullProgress("backend zip", p, t, tot);
        if (tty) process.stderr.write(`\r${line.padEnd(79)}`);
        else if (p % 5 === 0 || p === 100) process.stderr.write(`${line}\n`);
      },
    });
    if (tty) process.stderr.write("\n");
    process.stdout.write("done. run 'atomic-agent models start' to use the new backend.\n");
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export async function runLocalModelsRemove(idArg: string | undefined): Promise<number> {
  if (!idArg || !isKnownLocalModelId(idArg)) {
    process.stderr.write(
      `unknown model id. Valid: ${LOCAL_MODELS_CATALOG.map((m) => m.id).join(", ")}\n`,
    );
    return 1;
  }
  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  if (
    cfg.localModels.mode === "managed" &&
    cfg.localModels.managed.modelId === idArg
  ) {
    const st = await getDaemonStatus(dataDir, cfg.localModels.managed.port);
    if (st.running) {
      process.stderr.write(
        "cannot remove active model while daemon is running. Run 'atomic-agent models stop' first\n",
      );
      return 1;
    }
  }
  await removeModel(dataDir, idArg);
  process.stdout.write(`removed ${idArg}\n`);
  return 0;
}
