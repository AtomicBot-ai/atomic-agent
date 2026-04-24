import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Seed a minimal `<stateDir>/config.json` so the spawned agent talks to
 * the caller's llama-server instead of the hard-coded 127.0.0.1:8080
 * default. Only emits the file when `ATOMIC_AGENT_EVAL_LLAMA_URL` is
 * set — otherwise the agent keeps its existing behaviour (and will
 * still time out loudly if the default port is not reachable, which is
 * the honest signal).
 *
 * We deliberately write only the 6 user-facing keys covered by the
 * config schema. Everything else is env-driven and untouched here.
 *
 * `approvalRequired: false` is redundant with the `--no-approval` CLI
 * flag the harness already passes, but keeping both makes the intent
 * explicit if someone later spawns the agent without the flag.
 */
export function seedStateDirConfig(stateDir: string): void {
  const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
  if (!llamaUrl || llamaUrl.length === 0) return;

  const body = {
    version: 2,
    llama: { url: llamaUrl },
    log: { level: "info" },
    agent: {
      tokenBudget: 3000,
      maxSteps: 25,
      toolTimeoutMs: 60_000,
      approvalRequired: false,
      conversationMaxTokens: 32_000,
      worldSnapshotMaxTokens: 8_000,
    },
    http: {
      enabled: true,
      approvalMode: "writes",
      hostAllowlist: null,
      maxResponseBytes: 1_048_576,
      defaultTimeoutMs: 30_000,
    },
    tracing: {
      trace: { enabled: true, maxBytesPerSession: 10 * 1024 * 1024 },
    },
  };
  writeFileSync(join(stateDir, "config.json"), JSON.stringify(body, null, 2), "utf8");
}
