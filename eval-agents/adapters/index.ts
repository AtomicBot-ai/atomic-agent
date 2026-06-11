import type { AgentAdapter } from "../harness/agent-adapter.js";
import { createAtomicAgentAdapter } from "./atomic-agent-adapter.js";
import { createHermesAdapter } from "./hermes-adapter.js";
import { createOpenclawAdapter } from "./openclaw-adapter.js";

export { createAtomicAgentAdapter } from "./atomic-agent-adapter.js";
export { createHermesAdapter } from "./hermes-adapter.js";
export { createOpenclawAdapter } from "./openclaw-adapter.js";

export const AGENT_FACTORIES: ReadonlyArray<() => AgentAdapter> = [
  createAtomicAgentAdapter,
  createHermesAdapter,
  createOpenclawAdapter,
];

export function listAgentAdapters(filterIds?: readonly string[]): AgentAdapter[] {
  const want = filterIds?.length
    ? new Set(filterIds.map((id) => id.trim()).filter(Boolean))
    : null;
  return AGENT_FACTORIES
    .map((factory) => factory())
    .filter((adapter) => !want || want.has(adapter.id));
}
