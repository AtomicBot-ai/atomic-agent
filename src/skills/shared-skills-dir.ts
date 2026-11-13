import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Folder that `npx skills` (vercel-labs/skills), Codex, Cline, Pi and Zed
 * use for skills installed "for all agents". Local and cloud discovery
 * read it with the lowest priority (ATO-706).
 *
 * `homeDir` given: `<homeDir>/.agents/skills`; `null`: no shared folder;
 * omitted: `ATOMIC_AGENT_SHARED_SKILLS_DIR` if set, else the user's home.
 */
export function sharedAgentSkillsDir(homeDir?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (homeDir === null) return null;
  if (homeDir !== undefined) return resolve(homeDir, ".agents", "skills");
  const override = env.ATOMIC_AGENT_SHARED_SKILLS_DIR?.trim();
  return override ? resolve(override) : resolve(homedir(), ".agents", "skills");
}
