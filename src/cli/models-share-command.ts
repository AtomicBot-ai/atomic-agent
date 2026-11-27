import { getConfig, resetConfigCache } from "../config/index.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "../config/config-file.js";
import type { UserConfigFile } from "../config/config-schema.js";
import { ensureModelShareKey, modelShareKeyPath, rotateModelShareKey } from "../http/model-share-key.js";
import { RAW_MODEL_PREFIX } from "../http/route-raw-model.js";
import { formatShareSummary, networkServeHint, resolveShareReach, type ShareReach } from "./models-share-reach.js";
import { isAlive } from "./serve-orphan-guard.js";
import { readServeRecords, type ServeRecord } from "./serve-reaper.js";

export { formatShareSummary } from "./models-share-reach.js";

/**
 * `atomic-agent models share [--rotate] [--off] [--port <p>] [--json]`
 * (ATO-2336): let other apps and devices use the local model.
 *
 * Turns `localModels.managed.share` on, makes the share key on first use
 * (`--rotate` replaces it, so every app that held the old one is cut off)
 * and prints what to paste into the other app: the base URL of serve's
 * `/raw/v1` routes and the key. `--off` turns sharing off; the key file is
 * kept, so turning it on again does not break the apps already set up.
 * A running serve reads the switch and the key on every request.
 */

export const SHARE_HELP =
  [
    "atomic-agent models share: let other apps and devices use the local model",
    "",
    "Usage:",
    "  atomic-agent models share [--rotate] [--port <p>] [--json]",
    "  atomic-agent models share --off",
    "",
    "Turns sharing on and prints the base URL and the key to paste into an",
    `OpenAI-compatible app. \`atomic-agent serve\` then answers ${RAW_MODEL_PREFIX}/models and`,
    `${RAW_MODEL_PREFIX}/chat/completions with the bare model (no agent, no tools), only`,
    "for that key, one request at a time.",
    "",
    "  --rotate     Make a new key; apps that used the old one get 401",
    "  --off        Stop sharing (the routes answer 404); the key is kept",
    "  --port <p>   The port serve listens on (default: the running serve, else 8787)",
    "  --json       Print { enabled, serving, key, urls, keyPath } instead",
    "",
    "It answers only while atomic-agent serve runs.",
    ...networkServeHint(8787),
  ].join("\n") + "\n";

export interface ShareArgs {
  off: boolean;
  rotate: boolean;
  /** `--port`; `null` means the running serve's port, else 8787. */
  port: number | null;
  json: boolean;
}

export function parseShareArgs(args: readonly string[]): ShareArgs | { help: true } | { error: string } {
  const out: ShareArgs = { off: false, rotate: false, port: null, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case "-h":
      case "--help":
        return { help: true };
      case "--off":
        out.off = true;
        break;
      case "--rotate":
        out.rotate = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--port": {
        const value = args[++i];
        const port = value ? Number.parseInt(value, 10) : NaN;
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "--port expects an integer in 1..65535" };
        out.port = port;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (out.off && out.rotate) return { error: "--off and --rotate cannot be used together" };
  return out;
}

/** The `--json` shape: `serving` says whether a serve answers and where it listens (ATO-2758). */
export function shareJson(key: string, reach: ShareReach, keyPath: string): Record<string, unknown> {
  return {
    enabled: true,
    serving: reach.kind === "stopped" ? null : { port: reach.port, network: reach.kind === "network" },
    key,
    urls: { local: reach.local, lan: reach.kind === "network" ? reach.lan.filter((u) => u !== reach.local) : [] },
    keyPath,
  };
}

/** Write `localModels.managed.share` to the config file; no write when it already holds `enabled`. */
export function setModelShareEnabled(path: string, enabled: boolean): void {
  const user = ensureUserConfigFileSync(path);
  if (user.localModels.managed.share === enabled) return;
  const next: UserConfigFile = {
    ...user,
    localModels: {
      ...user.localModels,
      managed: { ...user.localModels.managed, share: enabled },
    },
  };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
}

export interface ModelsShareDeps {
  serveRecords?: (stateDir: string) => readonly ServeRecord[];
  isAlive?: (pid: number) => boolean;
}

export async function runModelsShare(args: readonly string[], deps: ModelsShareDeps = {}): Promise<number> {
  const parsed = parseShareArgs(args);
  if ("help" in parsed) {
    process.stdout.write(SHARE_HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`models share: ${parsed.error}\n${SHARE_HELP}`);
    return 2;
  }
  const config = getConfig();
  if (parsed.off) {
    setModelShareEnabled(config.paths.userConfigFile, false);
    if (parsed.json) process.stdout.write(`${JSON.stringify({ enabled: false })}\n`);
    else process.stdout.write(`Model sharing is off: ${RAW_MODEL_PREFIX} answers 404. The key is kept for next time.\n`);
    return 0;
  }
  const stateDir = config.paths.stateDir;
  const key = parsed.rotate ? rotateModelShareKey(stateDir) : ensureModelShareKey(stateDir);
  if (key === null) {
    process.stderr.write(`models share: the key file ${modelShareKeyPath(stateDir)} could not be read or written\n`);
    return 1;
  }
  setModelShareEnabled(config.paths.userConfigFile, true);
  const reach = resolveShareReach({
    records: (deps.serveRecords ?? ((dir: string) => readServeRecords(dir).map((r) => r.record)))(stateDir),
    isAlive: deps.isAlive ?? isAlive,
    port: parsed.port,
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(shareJson(key, reach, modelShareKeyPath(stateDir)))}\n`);
  } else {
    process.stdout.write(formatShareSummary({ key, reach, rotated: parsed.rotate }));
  }
  return 0;
}
