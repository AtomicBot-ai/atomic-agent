# Operational and helper defaults

Status: current
Owner: src/config/

These operational keys resolve through ENV_DEFAULTS rather than USER_CONFIG_DEFAULTS. Check [schema](../config-schema.ts) and load-config when changing precedence. The separate [user snapshot](user-defaults.md) owns config.json defaults.

## Environment-backed operations

- `agent.maxParallelToolCalls` (default `8`).
- `agent.batchToolResultCharCap` (default `32000`).
- `agent.shellToolResultCharCap` (default `16000`).
- `agent.shellToolResultTailLines` (default `500`).
- `agent.loopWarningThreshold` (default `3`).
- `agent.loopCriticalThreshold` (default `5`).
- `agent.loopBreakerVetoStreak` (default `3`).
- `agent.loopHistorySize` (default `30`).
- `agent.loopWanderingThreshold` (default `6`).
- `agent.loopWanderingEscalation` (default `12`).
- `localModels.requestTimeoutMs` (default `300000`).
- `llama.completionRetries` (default `3`).
- `llama.completionRetryBackoffMs` (default `150`).
- `tasks.enabled` (default `true`).
- `tasks.maxAttempts` (default `3`).
- `tasks.backoffInitialMs` (default `1000`).
- `tasks.backoffMaxMs` (default `60000`).
- `tasks.runOnCreate` (default `true`).
- `tasks.staleAfterMs` (default `300000`).
- `tasks.schedulerEnabled` (default `true`).
- `tasks.schedulerTickMs` (default `5000`).
- `tasks.schedulerBatch` (default `10`).
- `tasks.agentToolsEnabled` (default `true`).
- `tasks.minIntervalMs` (default `1000`).

## Non-config helper parameters

These three names are deliberately outside both tables; the defaults test records that distinction explicitly rather than treating them as user config keys.

- `maxExpanded` (default `50`) is LinkStore.expand’s parameter fallback, separate from memory.links.maxExpanded. See [link store](../../memory/links/link-store.ts).
- `failureThreshold` (default `3`) belongs to DEFAULT_FALLBACK_TIMING. See [fallback config](../../llm/fallback/fallback-config.ts).
- `workers` (default `2`) belongs to the separate LLM run-mode surface. See [run-mode config](../llm-run-mode-config.ts).
