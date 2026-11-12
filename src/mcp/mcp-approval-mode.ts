/**
 * Whether an MCP tool asks before a call (ATO-1134).
 *
 * Without a per-server `approval` mode the answer is the one the adapter
 * always gave: an `approval_gated` server asks, unless the tool's own
 * `readOnlyHint: true` is trusted for it (`trustReadOnlyHint`: stdio
 * servers and the agent's own named exceptions, ATO-1178); a `pure_read`
 * server never asks. A mode set on the server replaces that answer for
 * its tools, and only that: batching still follows `trust`.
 */
import type { McpApprovalMode, McpTrustLevel } from "./mcp-types.js";

export interface McpPromptInputs {
  trust: McpTrustLevel;
  approval?: McpApprovalMode;
  /** The tool advertised `readOnlyHint === true` at discovery (strict boolean). */
  readOnlyHint: boolean;
  /** That hint may skip the prompt without a mode (see `trustsReadOnlyHintFor`). */
  trustReadOnlyHint: boolean;
}

export function mcpToolPrompts(input: McpPromptInputs): boolean {
  const trustedReadOnly = input.trustReadOnlyHint && input.readOnlyHint;
  switch (input.approval) {
    case undefined:
      return input.trust === "approval_gated" && !trustedReadOnly;
    case "ask":
      return !trustedReadOnly;
    case "ask_writes":
      // The operator chose to believe this server's read-only claims.
      return !input.readOnlyHint;
    case "auto":
      return false;
  }
}

/**
 * True when the mode let a call through that the server's default
 * (`approval` absent) would have asked about. Such a call still goes to
 * the gate when a saved deny or ask rule names it, so a mode set in
 * config never outvotes a rule the user saved.
 */
export function modeSkipsDefaultPrompt(input: McpPromptInputs): boolean {
  if (input.approval === undefined) return false;
  return (
    !mcpToolPrompts(input) &&
    mcpToolPrompts({ ...input, approval: undefined })
  );
}
