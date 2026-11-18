/**
 * The `### integrations` section of the stable prefix.
 *
 * Composio's meta-tools are useless if the model never reaches for
 * them. Without this section the catalogue reads as four opaque
 * `mcp.composio.COMPOSIO_*` entries with no hint that "email this to
 * Ivan" is a thing they can do — so the model answers "I can't send
 * email" while holding a tool that sends email. This block is the
 * difference between the tools existing and the tools being used.
 *
 * The text is ours, not Composio's. Their session response ships an
 * `experimental.assistive_prompt` that would drop in here verbatim,
 * but wiring a remote-controlled string straight into the system
 * prompt means a third party can silently re-steer the agent, and any
 * edit on their side invalidates the KV-cached prefix for every user
 * at once. A short local paragraph costs a few dozen tokens and keeps
 * both properties.
 *
 * Deliberately omitted: the list of already-connected apps. It would
 * be genuinely useful, but it changes the moment the operator
 * authorises something — i.e. mid-session — and the stable prefix is
 * the one part of the prompt that must not move. The model can ask
 * Composio directly; the cache stays intact.
 */

import type { ToolDescriptor } from "./stable-prefix.js";

/** Discovery tool whose presence means a Composio session is mounted. */
export const COMPOSIO_SEARCH_TOOL = "mcp.composio.COMPOSIO_SEARCH_TOOLS";

/**
 * Live iff the Composio search tool is in the catalog.
 *
 * Derived from the descriptors rather than passed in as a flag: the
 * descriptors already reflect exactly what got mounted this boot, so
 * the guidance cannot drift out of sync with the tools it describes.
 */
export function isComposioActive(
  descriptors: readonly ToolDescriptor[],
): boolean {
  return descriptors.some((d) => d.name === COMPOSIO_SEARCH_TOOL);
}

/**
 * The section body. Kept to four sentences: it sits in the KV-cached
 * prefix of every single turn, so each line has to earn its tokens.
 */
export const COMPOSIO_GUIDANCE = [
  "External accounts — Gmail, Slack, Notion, Linear, Jira, GitHub, Discord and ~1500 more apps — are reachable through Composio, which also handles their sign-in.",
  'When the user asks for something that lives in one of those apps, call `mcp.composio.COMPOSIO_SEARCH_TOOLS` with the use case (e.g. `{ queries: [{ use_case: "send an email" }] }`) before anything else — never guess an app tool\'s name or arguments.',
  "Then run what it found via `mcp.composio.COMPOSIO_MULTI_EXECUTE_TOOL` (use `mcp.composio.COMPOSIO_GET_TOOL_SCHEMAS` first if you need the exact arguments).",
  "If the account is not connected yet, `mcp.composio.COMPOSIO_MANAGE_CONNECTIONS` returns a sign-in link: put that URL in a `reply` so the user can click it, wait for them to confirm, then retry. Connections persist, so this happens once per app.",
].join("\n");

/** The slice of a `composio.accounts` entry the prompt needs. */
export interface ComposioAccountHint {
  toolkit: string;
  alias: string;
  isDefault: boolean;
}

/**
 * ATO-1494: one line saying which named account each app acts through,
 * so "send it from my work Gmail" is answered honestly instead of
 * silently going out through whichever account is pinned. `null` with
 * no named accounts, so an install that never named one keeps its
 * prefix byte-identical. The list is config, written only by the
 * operator (CLI, Integrations tab, desktop) and followed by a remount,
 * so it is as stable as the descriptor gate above it. Connected account
 * ids are left out: the model has no use for them.
 */
export function buildComposioAccountsGuidance(
  accounts: readonly ComposioAccountHint[] | undefined,
): string | null {
  if (accounts === undefined || accounts.length === 0) return null;
  const byToolkit = new Map<string, ComposioAccountHint[]>();
  for (const a of accounts) {
    const list = byToolkit.get(a.toolkit) ?? [];
    list.push(a);
    byToolkit.set(a.toolkit, list);
  }
  const parts = [...byToolkit.keys()].sort().map((toolkit) => {
    const list = byToolkit.get(toolkit)!;
    const def = list.find((a) => a.isDefault);
    const others = list
      .filter((a) => a !== def)
      .map((a) => `\`${a.alias}\``)
      .sort();
    const head = def
      ? `${toolkit} acts through \`${def.alias}\``
      : `${toolkit} has no default (Composio uses the account connected last)`;
    return others.length > 0 ? `${head}, also saved: ${others.join(", ")}` : head;
  });
  return [
    `Named Composio accounts: ${parts.join("; ")}.`,
    "Say which account you acted through when it matters. If the user wants a different saved account, ask them to make it the default in Integrations (or `atomic-agent composio accounts default <app> <name>`); you cannot switch it yourself.",
  ].join("\n");
}
