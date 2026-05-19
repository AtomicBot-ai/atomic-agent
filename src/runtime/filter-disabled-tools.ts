import type { ToolDescriptor } from "../prompt/stable-prefix.js";

/**
 * Config gates that decide which `DEFAULT_TOOL_DESCRIPTORS` entries
 * are actually backed by a registered tool at runtime.
 *
 * Background: each tool family is independently registered in
 * `bootstrap.ts` (see `registerMemoryTools`, `registerTaskTools`,
 * `registerVisionTools`) based on its master switch. The
 * **descriptor catalog** in `src/prompt/default-tool-descriptors-*.ts`
 * is static, however — it always lists every tool. Without this
 * filter the stable prefix advertises tools the registry will reject,
 * and the agent loop fails the turn with
 * `tool not registered in this agent: <name>` the moment the model
 * picks one of them (e.g. `memory.procedures.recall` under the
 * out-of-the-box default `memory.procedures.enabled=false`).
 *
 * The vision filter used to live inline in `bootstrap.ts`; this
 * module generalises it to cover every family with a runtime gate
 * (memory profile / notes / lessons / procedures, tasks, vision).
 *
 * Keep the gate names verbatim from the config schema — they double
 * as the documented mapping for downstream readers.
 */
export interface ToolGateConfig {
  vision: { enabled: boolean; providerAvailable: boolean };
  memory: {
    profile: { enabled: boolean };
    notes: { enabled: boolean };
    lessons: { enabled: boolean };
    procedures: { enabled: boolean };
  };
  tasks: { agentToolsEnabled: boolean };
}

/**
 * Tool names grouped by the config switch that gates them.
 * The list mirrors `registerMemoryTools` / `registerTaskTools` /
 * `registerVisionTools` exactly — if a new tool is added there with
 * a master switch, add it here too **and** to
 * `filter-disabled-tools.test.ts`.
 */
const GATED_TOOLS = {
  vision: ["vision.describe"],
  memoryProfile: [
    "memory.profile.set",
    "memory.profile.remove",
    "memory.profile.list",
    "memory.profile.history",
  ],
  memoryNotes: [
    "memory.notes.store",
    "memory.notes.recall",
    "memory.notes.forget",
  ],
  memoryLessons: ["memory.lessons.recall"],
  memoryProcedures: ["memory.procedures.recall"],
  tasks: [
    "tasks.schedule",
    "tasks.cron",
    "tasks.list",
    "tasks.cancel",
    "tasks.show",
  ],
} as const;

/**
 * Drop descriptors whose backing tool will not be registered at
 * runtime under the supplied gates. Pure / total / no side effects.
 */
export function filterToolDescriptorsByConfig(
  descriptors: readonly ToolDescriptor[],
  gates: ToolGateConfig,
): readonly ToolDescriptor[] {
  const disabled = new Set<string>();

  if (!gates.vision.enabled || !gates.vision.providerAvailable) {
    for (const name of GATED_TOOLS.vision) disabled.add(name);
  }
  if (!gates.memory.profile.enabled) {
    for (const name of GATED_TOOLS.memoryProfile) disabled.add(name);
  }
  if (!gates.memory.notes.enabled) {
    for (const name of GATED_TOOLS.memoryNotes) disabled.add(name);
  }
  if (!gates.memory.lessons.enabled) {
    for (const name of GATED_TOOLS.memoryLessons) disabled.add(name);
  }
  if (!gates.memory.procedures.enabled) {
    for (const name of GATED_TOOLS.memoryProcedures) disabled.add(name);
  }
  if (!gates.tasks.agentToolsEnabled) {
    for (const name of GATED_TOOLS.tasks) disabled.add(name);
  }

  if (disabled.size === 0) return descriptors;
  return descriptors.filter((d) => !disabled.has(d.name));
}

/** Exported for tests — keep in sync with `filterToolDescriptorsByConfig`. */
export const GATED_TOOL_NAMES = GATED_TOOLS;
