import { getConfig, resetConfigCache } from "../config/index.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "../config/config-file.js";
import type { UserConfigFile } from "../config/config-schema.js";
import { ensureModelShareKey, modelShareKeyPath, rotateModelShareKey } from "../http/model-share-key.js";
import { RAW_MODEL_PREFIX } from "../http/route-raw-model.js";
import { readModelShareSettings, writeModelShareMode, writeModelSharePort } from "../http/model-share-settings.js";
import { formatShareSummary, resolveShareReach, type ShareReach } from "./models-share-reach.js";
import { lanUrls } from "./serve-args.js";
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
    "  atomic-agent models share [--local | --network] [--rotate] [--port <p>] [--json]",
    "  atomic-agent models share --off",
    "",
    "Turns sharing on and prints the base URL and the key to paste into an",
    `OpenAI-compatible app. \`atomic-agent serve\` then answers ${RAW_MODEL_PREFIX}/models and`,
    `${RAW_MODEL_PREFIX}/chat/completions with the bare model (no agent, no tools), only`,
    "for that key, one request at a time.",
    "",
    "  --local      Only apps on this computer (127.0.0.1)",
    "  --network    Other devices too: serve opens <port> on 0.0.0.0 with the",
    "               model routes only, plain http. Asked for each time: --off forgets it",
    "  --rotate     Make a new key; apps that used the old one get 401",
    "  --off        Stop sharing (the routes answer 404); the key is kept",
    "  --port <p>   The shared model's port, saved as localModels.managed.sharePort (default 8787)",
    "  --json       Print { enabled, mode, listening, key, urls, keyPath } instead",
    "",
    "It answers only while atomic-agent serve (or the desktop app) runs.",
    "A serve that itself listens on <port> answers there. In --local mode only apps on",
    "this computer get an answer, also from a serve started with --host 0.0.0.0.",
  ].join("\n") + "\n";

export interface ShareArgs {
  /** ATO-2483: `--local` / `--network`; absent keeps the choice in the config file. */
  where?: "local" | "network";
  off: boolean;
  rotate: boolean;
  /** ATO-2483: `--port` writes `localModels.managed.sharePort`; `null` keeps the saved port. */
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
      case "--local":
      case "--network": {
        const where = flag === "--local" ? "local" : "network";
        if (out.where && out.where !== where) return { error: "--local and --network cannot be used together" };
        out.where = where;
        break;
      }
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
  if (out.off && out.where) return { error: `--off and --${out.where} cannot be used together` };
  return out;
}

/** The base URLs another app pastes: this computer first, then each LAN address. */
export function shareBaseUrls(port: number, lan: readonly string[] = lanUrls("0.0.0.0", port)): { local: string; lan: string[] } {
  return {
    local: `http://127.0.0.1:${port}${RAW_MODEL_PREFIX}`,
    lan: lan.map((origin) => `${origin}${RAW_MODEL_PREFIX}`),
  };
}

/** The `--json` shape; `listening` says whether a serve answers now (ATO-2758). */
export function shareJson(key: string, reach: ShareReach, keyPath: string): Record<string, unknown> {
  return { enabled: true, mode: reach.mode, listening: reach.listening, key, urls: reach.urls, keyPath };
}

/**
 * Write `localModels.managed.share` to the config file; no write when it
 * already holds `enabled`. Off also drops `shareNetwork` (ATO-2483).
 */
export function setModelShareEnabled(path: string, enabled: boolean): void {
  const user = ensureUserConfigFileSync(path);
  if (user.localModels.managed.share === enabled) return;
  const { shareNetwork: _forgotten, ...rest } = user.localModels.managed;
  const next: UserConfigFile = {
    ...user,
    localModels: {
      ...user.localModels,
      managed: enabled ? { ...user.localModels.managed, share: true } : { ...rest, share: false },
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
    // ATO-2483: off also forgets --network, so the network is chosen again each time.
    writeModelShareMode(config.paths.userConfigFile, "off");
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
  if (parsed.where) writeModelShareMode(config.paths.userConfigFile, parsed.where);
  else setModelShareEnabled(config.paths.userConfigFile, true);
  if (parsed.port !== null) writeModelSharePort(config.paths.userConfigFile, parsed.port);
  // ATO-2483: the same rule as GET /api/model-share: the saved port, and
  // addresses for other devices only when the mode lets them in.
  const settings = readModelShareSettings(config.paths.userConfigFile);
  const mode = settings.mode === "network" ? "network" : "local";
  const reach = resolveShareReach({
    records: (deps.serveRecords ?? ((dir: string) => readServeRecords(dir).map((r) => r.record)))(stateDir),
    isAlive: deps.isAlive ?? isAlive,
    mode,
    port: settings.port,
    urls: shareBaseUrls(settings.port, mode === "network" ? undefined : []),
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(shareJson(key, reach, modelShareKeyPath(stateDir)))}\n`);
  } else {
    process.stdout.write(
      formatShareSummary({ key, urls: reach.urls, rotated: parsed.rotate, network: mode === "network", listening: reach.listening }),
    );
  }
  return 0;
}
