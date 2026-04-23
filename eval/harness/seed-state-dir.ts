import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal user-facing config written into every eval case's temp
 * stateDir. Only pins the handful of knobs eval needs:
 *
 *   - `llama.url`      so the agent hits the real llama-server instead
 *                      of the 127.0.0.1:8080 USER_CONFIG_DEFAULT.
 *   - `agent.approvalRequired: false` matches `--no-approval` on the CLI.
 *   - `telemetry.trace.enabled: true` so `collectTraceMetrics` has input.
 *
 * Everything else (memory, http, agent budgets) falls back to
 * `USER_CONFIG_DEFAULTS` inside `parseUserConfigFile`, which we rely on
 * to absorb future additive schema changes without touching this seed.
 */
export interface SeedOptions {
  stateDir: string;
  llamaUrl: string;
}

export function seedStateDir({ stateDir, llamaUrl }: SeedOptions): void {
  const payload = {
    version: 2,
    llama: { url: llamaUrl },
    agent: { approvalRequired: false },
    telemetry: { trace: { enabled: true } },
  };
  writeFileSync(
    join(stateDir, "config.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}
