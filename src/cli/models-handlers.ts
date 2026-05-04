import { getConfig, resetConfigCache } from "../config/index.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "../config/config-file.js";
import type { UserConfigFile } from "../config/config-schema.js";
import {
  checkForBackendUpdate,
  downloadBackend,
  downloadModel,
  getDaemonStatus,
  getLocalModelDef,
  isBackendDownloaded,
  isKnownLocalModelId,
  isMmprojDownloaded,
  isModelDownloaded,
  LOCAL_MODELS_CATALOG,
  readBackendVersion,
  removeModel,
  resolveChatTemplatePath,
  resolveMmprojFilePath,
  startDaemon,
  stopDaemon,
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
    const path = `${dataDir}/models/${m.id}/${m.filename}`;
    process.stdout.write(`done. model saved to ${path}\n`);
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
  try {
    const { pid } = await startDaemon({
      dataDir,
      modelId: mid,
      port: cfg.localModels.managed.port,
      chatTemplateFile: tpl,
      mmprojFile,
    });
    const visionLine = mmprojFile
      ? `, vision enabled (${m.mmprojFilename})`
      : m.supportsVision
        ? `, vision disabled (mmproj missing — download via TUI 'Local Models' panel)`
        : "";
    process.stdout.write(
      `started pid ${pid}, healthy on port ${cfg.localModels.managed.port}${visionLine}\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export async function runLocalModelsStop(): Promise<number> {
  await stopDaemon(getConfig().paths.localModelsDataDir);
  process.stdout.write("stopped\n");
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
    if (st.running) await stopDaemon(dataDir);
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
