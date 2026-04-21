import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
  ENV_DEFAULTS,
  type AtomicAgentConfig,
  type BrowserChannel,
  type LogLevel,
} from "./config-schema.js";
import {
  ensureUserConfigFileSync,
  getUserConfigPath,
} from "./config-file.js";

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

function readInt(key: string, fallback: number): number {
  const raw = readEnv(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = readEnv(key);
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function readBrowserChannel(key: string, fallback: BrowserChannel): BrowserChannel {
  const raw = readEnv(key)?.toLowerCase();
  if (raw === "chrome" || raw === "msedge" || raw === "chromium") return raw;
  return fallback;
}

function resolvePath(raw: string | undefined, fallback: string): string {
  const value = raw ?? fallback;
  if (value.startsWith("~")) {
    return resolve(homedir(), value.slice(2));
  }
  if (isAbsolute(value)) return value;
  return resolve(process.cwd(), value);
}

function resolveAssetDir(envKey: string, relativeDefault: string): string {
  const raw = readEnv(envKey);
  if (raw) {
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }
  return resolve(process.cwd(), relativeDefault);
}

/**
 * Assemble the full runtime config. User-facing keys (llama.url,
 * log.level, agent.tokenBudget/maxSteps/toolTimeoutMs/approvalRequired)
 * come from `<stateDir>/config.json`; everything else stays in env
 * variables.
 */
export function loadConfig(): AtomicAgentConfig {
  const stateDir = resolvePath(
    readEnv("ATOMIC_AGENT_STATE_DIR"),
    ENV_DEFAULTS.STATE_DIR,
  );
  const userConfigFile = getUserConfigPath(stateDir);
  const user = ensureUserConfigFileSync(userConfigFile);
  const grammarsDir = resolveAssetDir("ATOMIC_AGENT_GRAMMARS_DIR", "grammars");

  const browserChannel: BrowserChannel = readBrowserChannel(
    "ATOMIC_AGENT_BROWSER_CHANNEL",
    ENV_DEFAULTS.BROWSER_CHANNEL,
  );
  const logLevel: LogLevel = user.log.level;

  return {
    llama: {
      url: user.llama.url,
      apiKey: readEnv("ATOMIC_AGENT_LLAMA_API_KEY") ?? null,
      healthPath: "/health",
      completionPath: "/completion",
      healthTimeoutMs: readInt(
        "ATOMIC_AGENT_LLAMA_HEALTH_TIMEOUT_MS",
        ENV_DEFAULTS.HEALTH_TIMEOUT_MS,
      ),
      requestTimeoutMs: readInt(
        "ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS",
        ENV_DEFAULTS.REQUEST_TIMEOUT_MS,
      ),
      healthRetries: readInt(
        "ATOMIC_AGENT_LLAMA_HEALTH_RETRIES",
        ENV_DEFAULTS.HEALTH_RETRIES,
      ),
      healthRetryBackoffMs: readInt(
        "ATOMIC_AGENT_LLAMA_HEALTH_BACKOFF_MS",
        ENV_DEFAULTS.HEALTH_BACKOFF_MS,
      ),
      defaultSlotId: readInt(
        "ATOMIC_AGENT_LLAMA_DEFAULT_SLOT",
        ENV_DEFAULTS.DEFAULT_SLOT_ID,
      ),
    },
    paths: {
      stateDir,
      sessionsDbFile: resolve(stateDir, "sessions.sqlite"),
      grammarsDir,
      browserProfileDir: resolve(stateDir, "browser-profile"),
      globalSkillsDir: resolve(stateDir, "skills"),
      projectSkillsDirName: ENV_DEFAULTS.PROJECT_SKILLS_DIR,
      userConfigFile,
    },
    agent: {
      tokenBudget: user.agent.tokenBudget,
      maxSteps: user.agent.maxSteps,
      toolTimeoutMs: user.agent.toolTimeoutMs,
      approvalRequired: user.agent.approvalRequired,
      stablePrefixHashSalt:
        readEnv("ATOMIC_AGENT_STABLE_PREFIX_SALT") ??
        ENV_DEFAULTS.STABLE_PREFIX_SALT,
    },
    browser: {
      channel: browserChannel,
      headless: readBool(
        "ATOMIC_AGENT_BROWSER_HEADLESS",
        ENV_DEFAULTS.BROWSER_HEADLESS,
      ),
      cdpUrl: readEnv("ATOMIC_AGENT_BROWSER_CDP_URL") ?? null,
      launchTimeoutMs: readInt(
        "ATOMIC_AGENT_BROWSER_LAUNCH_TIMEOUT_MS",
        ENV_DEFAULTS.BROWSER_LAUNCH_TIMEOUT_MS,
      ),
    },
    skills: {
      catalogTokenBudget: readInt(
        "ATOMIC_AGENT_SKILLS_CATALOG_BUDGET",
        ENV_DEFAULTS.SKILLS_CATALOG_BUDGET,
      ),
    },
    log: { level: logLevel },
  };
}
