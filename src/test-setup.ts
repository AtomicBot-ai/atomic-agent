import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup: point every test at an isolated `STATE_DIR` so
 * that any accidental `getConfig()` call never writes to the user's real
 * `~/.atomic-agent/`. Tests that need a specific state dir override
 * `process.env.ATOMIC_AGENT_STATE_DIR` in their own `beforeEach`.
 */
if (!process.env.ATOMIC_AGENT_STATE_DIR) {
  process.env.ATOMIC_AGENT_STATE_DIR = mkdtempSync(
    join(tmpdir(), "atomic-agent-test-"),
  );
}

/**
 * Keep cloud skill discovery away from the real `~/.agents/skills`
 * (ATO-706): a missing folder means no shared skills in tests.
 */
if (!process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR) {
  process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR = join(
    mkdtempSync(join(tmpdir(), "atomic-agent-shared-skills-")),
    "missing",
  );
}

/**
 * Keep slash commands away from the real `~/.claude/commands` (ATO-2441):
 * an empty value means the folder is not read.
 */
if (process.env.ATOMIC_AGENT_CLAUDE_COMMANDS_DIR === undefined) {
  process.env.ATOMIC_AGENT_CLAUDE_COMMANDS_DIR = "";
}

/**
 * Never fetch a developer's real organization policy (ATO-587) from a
 * test: the loader tests pass their own env.
 */
delete process.env.ATOMIC_POLICY_URL;
