import { readFileSync } from "node:fs";
import {
  parseAgentProfilesConfig,
  type UserAgentProfilesConfig,
} from "../config/agent-profiles-schema.js";
import { SETTINGS_AGENT_PROFILES_KEY } from "./profile-loader.js";

/**
 * `llm.runMode.agentProfiles` read fresh from `config.json` (ATO-1668),
 * the way project trust is reread (`readProjectTrust`): the desktop app
 * and the terminal share one file, and a hand edit or the other
 * process's write must apply on the next fan-out without a restart.
 *
 * Only that node is parsed, by the config's own parser, so a broken
 * entry is skipped with the same notice as at startup and an unrelated
 * problem elsewhere in the file does not hide the profiles. No file
 * means no settings profiles. A file that cannot be read, is not JSON,
 * or holds a node that is not an object falls back to `fallback` (the
 * process's cached config).
 */
export function readSettingsAgentProfiles(
  configFile: string,
  fallback: () => UserAgentProfilesConfig | undefined,
): UserAgentProfilesConfig | undefined {
  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fallback();
  }
  try {
    const tree = JSON.parse(text) as { llm?: { runMode?: { agentProfiles?: unknown } } } | null;
    return parseAgentProfilesConfig(tree?.llm?.runMode?.agentProfiles, SETTINGS_AGENT_PROFILES_KEY);
  } catch {
    return fallback();
  }
}
