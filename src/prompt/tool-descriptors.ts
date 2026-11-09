import type { ToolDescriptor } from "./stable-prefix.js";
import { DEFAULT_TOOL_DESCRIPTORS_A } from "./default-tool-descriptors-a.js";
import { DEFAULT_TOOL_DESCRIPTORS_B } from "./default-tool-descriptors-b.js";
import { attachDefaultArgsJsonSchema } from "./default-tool-args-schemas.js";
import { COMPACT_TOOL_FORMS } from "./compact-tool-forms.js";

/**
 * Pairs each default descriptor with its authored short form
 * (`compact-tool-forms.ts`), read only by the compact prompt. Kept in
 * its own table, like `argsJsonSchema`, so the long descriptors and the
 * tool contracts they come from stay untouched.
 */
function attachCompactForm(descriptor: ToolDescriptor): ToolDescriptor {
  if (descriptor.compact) return descriptor;
  const form = COMPACT_TOOL_FORMS.get(descriptor.name);
  return form ? { ...descriptor, compact: form } : descriptor;
}

/**
 * Default tool descriptors. `argsSchema` uses a compact TS-like form
 * that the LLM reads via the stable prefix; `argsJsonSchema` carries
 * the structured shape used by the cloud `native_tools` transport
 * (see `default-tool-args-schemas.ts`). The two are kept in sync by
 * convention — the JSON Schema is authoritative for validation, the
 * text is authoritative for prompt rendering.
 *
 * `tier: "rare"` tools render as one-line manifests; use `tool.view`
 * to load the full schema into `### loaded-tools`.
 */
export const DEFAULT_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  ...DEFAULT_TOOL_DESCRIPTORS_A,
  ...DEFAULT_TOOL_DESCRIPTORS_B,
]
  .map(attachDefaultArgsJsonSchema)
  .map(attachCompactForm);

const TOOL_DESCRIPTOR_BY_NAME: ReadonlyMap<string, ToolDescriptor> = new Map(
  DEFAULT_TOOL_DESCRIPTORS.map((d) => [d.name, d] as const),
);

export function getToolDescriptorByName(
  name: string,
): ToolDescriptor | undefined {
  return TOOL_DESCRIPTOR_BY_NAME.get(name);
}

export function isRareToolName(name: string): boolean {
  return getToolDescriptorByName(name)?.tier === "rare";
}

/**
 * Rare in either scaffold: `tier: "rare"`, or collapsed to a one-liner
 * by the compact prompt (`compact.tier`). `tool.view` loads both. Under
 * the full scaffold a compact-only rare tool is already described in
 * full, so `### loaded-tools` skips the copy. Error-path auto-expansion
 * (`autoExpandRareOnError`) still keys on `tier` alone.
 */
export function isViewableRareTool(descriptor: ToolDescriptor): boolean {
  return descriptor.tier === "rare" || descriptor.compact?.tier === "rare";
}
