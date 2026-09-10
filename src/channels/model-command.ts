/**
 * `/model` for the chat channels — report what the agent runs on, and
 * switch it from Telegram or Discord.
 *
 * Remote operators only ever had the TUI for this, so a bot running on
 * someone else's machine was pinned to whatever model that machine was
 * last told to use. The state read and written here is deliberately the
 * *same* state the TUI's LLM pane owns — the active text provider and
 * that provider's `defaultChatModel` in the user config, plus the
 * per-session `llm` stamp from `session-llm.ts`. There is no second,
 * channel-local store: a model picked from Telegram has to be the model
 * the TUI then shows, and the session stamp has to be the one a session
 * switch reads back.
 *
 * Both handlers dispatch into here from their own `/model` case. Only
 * the id decoration differs between them (Discord wraps ids in
 * backticks, Telegram sends plain text), which is what `code` is for —
 * the wording itself stays shared so the two surfaces cannot drift.
 *
 * The grammar is deliberately strict: a bare token is a *provider*, and
 * a model must be qualified with the provider it belongs to. Guessing
 * that an unrecognised token is a model id on the active provider would
 * silently pin a typo as the chat model and leave the agent broken
 * until someone opened the TUI; a refusal that names the configured
 * providers costs one message and teaches the form.
 */

import { getConfig } from "../config/index.js";
import { resolveLlmProviderApiKey } from "../config/resolve-llm-api-key.js";
import {
  resolveLlmConfig,
  type LlmProviderConfigEntry,
} from "../llm/provider/registry/index.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { SESSION_LLM_METADATA_KEY } from "../session/index.js";
import {
  setActiveTextProviderInConfig,
  setProviderDefaultChatModelInConfig,
} from "../tui/persist-llm-provider.js";

/** What a channel hands `/model` about the chat it arrived in. */
export interface ModelCommandChat {
  runtime: AgentRuntime;
  /** The session this chat points at, or `null` when it has none yet. */
  sessionId: string | null;
  /** Decorate an id for the host chat — bare on Telegram, `code` on Discord. */
  code: (text: string) => string;
}

/**
 * Provider kinds whose entry is useless without a resolvable API key.
 * Everything else is left alone on purpose: `llama-server` never wants
 * one, and a keyless `openai-compatible` entry is how LM Studio and
 * friends are configured (see `resolve-llm-api-key.ts`), so demanding a
 * key there would refuse a working setup.
 */
const KEY_REQUIRED_KINDS = new Set(["openrouter", "aimlapi", "gemini"]);

/**
 * Run `/model` and return the message to post. Never throws: a config
 * write or a provider reload that fails comes back as a plain refusal,
 * because the handlers that call this must not let one bad command take
 * the channel down.
 */
export async function runModelCommand(
  args: readonly string[],
  chat: ModelCommandChat,
): Promise<string> {
  const resolved = resolveLlmConfig(getConfig());
  if (args.length === 0) return formatReport(resolved, chat.code);

  const target = resolveTarget(args, resolved, chat.code);
  if (!target.ok) return target.message;

  // Same shape as `/switch`: the arguments are validated first so a
  // typo is answered as a typo, and only a command that would actually
  // change something is refused for being mid-turn. Switching under a
  // running turn would swap the provider out from under its remaining
  // steps, so this refuses rather than deferring — the operator can
  // `/cancel` or wait, and either way knows which model ran.
  if (chat.sessionId && chat.runtime.turnController.isBusy(chat.sessionId)) {
    return "This chat has a turn in progress; try /model again when it finishes.";
  }

  try {
    if (target.modelId !== null) {
      setProviderDefaultChatModelInConfig(target.providerId, target.modelId);
    }
    // Same order the TUI's `selectChatModel` uses: write the model,
    // rebuild the provider from the now-current config, then make it
    // active. A provider the registry has never built (added to the
    // config after boot) needs the full merge instead of a replace.
    if (chat.runtime.providerRegistry.listIds().includes(target.providerId)) {
      await chat.runtime.reloadLlmProvider(target.providerId);
    } else {
      await chat.runtime.reloadLlmProviders();
    }
    await chat.runtime.providerRegistry.setActive(target.providerId);
    setActiveTextProviderInConfig(target.providerId);
  } catch (err) {
    return `Could not switch to ${chat.code(target.providerId)}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  // Stamp the chat's session now rather than waiting for `executeTurn`
  // to do it at the top of the next turn: a `/model` followed by a
  // `/switch` away would otherwise lose the choice entirely, which is
  // the same reason the TUI stamps on selection (`session-llm.ts`).
  const chatModel = stampChatSession(chat, target.providerId);
  return `Now on ${chat.code(target.providerId)} · ${chat.code(
    chatModel ?? "provider default",
  )}. Takes effect on the next message.`;
}

type ResolvedTarget =
  | { ok: true; providerId: string; modelId: string | null }
  | { ok: false; message: string };

/**
 * Turn `/model` arguments into a provider (and optionally a model) or
 * into the reason it could not be done. Accepted forms:
 *
 *   /model <provider>                 — switch provider, keep its model
 *   /model <provider> <model-id>      — pin a model on that provider
 *   /model <provider>/<model-id>      — the same, in one token
 *
 * The one-token form splits at the FIRST slash, which is what makes it
 * work for the vendor-namespaced ids most gateways use
 * (`openrouter/anthropic/claude-opus-4`).
 */
function resolveTarget(
  args: readonly string[],
  resolved: ReturnType<typeof resolveLlmConfig>,
  code: (text: string) => string,
): ResolvedTarget {
  const first = args[0] ?? "";
  const [token, inlineModel] =
    args.length > 1 ? [first, args[1] ?? null] : splitAtFirstSlash(first);

  const match = matchProvider(token, resolved.providers);
  if (match.kind === "none") {
    const ids = resolved.providers.map((p) => code(p.id)).join(", ");
    return {
      ok: false,
      message: [
        `Unknown provider ${code(token)}.`,
        ids.length > 0 ? `Configured: ${ids}.` : "No providers are configured.",
        `A model id has to name its provider: ${code("/model <provider> <model-id>")}.`,
      ].join(" "),
    };
  }
  if (match.kind === "ambiguous") {
    return {
      ok: false,
      message: `${code(token)} matches ${match.ids
        .map((id) => code(id))
        .join(", ")} — say which one.`,
    };
  }

  const entry = match.entry;
  if (KEY_REQUIRED_KINDS.has(entry.kind) && !hasApiKey(entry)) {
    return {
      ok: false,
      message: `Provider ${code(entry.id)} has no API key configured; add one in the TUI's LLM tab before switching to it.`,
    };
  }
  const modelId = inlineModel === null ? null : inlineModel.trim();
  if (modelId !== null && modelId.length === 0) {
    return {
      ok: false,
      message: `Usage: ${code("/model <provider> <model-id>")}.`,
    };
  }
  return { ok: true, providerId: entry.id, modelId };
}

function splitAtFirstSlash(token: string): [string, string | null] {
  const at = token.indexOf("/");
  if (at < 0) return [token, null];
  return [token.slice(0, at), token.slice(at + 1)];
}

type ProviderMatch =
  | { kind: "exact"; entry: LlmProviderConfigEntry }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

/**
 * Exact id first, then a unique case-insensitive prefix. The prefix
 * step is what makes `/model openr` work from a phone keyboard; an
 * exact id always wins over it, so a provider whose id is a prefix of
 * another's is still reachable.
 */
function matchProvider(
  token: string,
  providers: readonly LlmProviderConfigEntry[],
): ProviderMatch {
  if (token.length === 0) return { kind: "none" };
  const lower = token.toLowerCase();
  const exact = providers.find((p) => p.id.toLowerCase() === lower);
  if (exact) return { kind: "exact", entry: exact };
  const prefixed = providers.filter((p) =>
    p.id.toLowerCase().startsWith(lower),
  );
  if (prefixed.length === 1 && prefixed[0]) {
    return { kind: "exact", entry: prefixed[0] };
  }
  if (prefixed.length > 1) {
    return { kind: "ambiguous", ids: prefixed.map((p) => p.id) };
  }
  return { kind: "none" };
}

function hasApiKey(entry: LlmProviderConfigEntry): boolean {
  return Boolean(resolveLlmProviderApiKey(entry)?.length);
}

/** The chat model an entry pins, or `null` when it names none. */
function chatModelOf(entry: LlmProviderConfigEntry): string | null {
  return entry.defaultChatModel ?? entry.model ?? null;
}

function formatReport(
  resolved: ReturnType<typeof resolveLlmConfig>,
  code: (text: string) => string,
): string {
  const activeId = resolved.activeTextProvider;
  const active = resolved.providers.find((p) => p.id === activeId);
  const lines = [
    active
      ? `Model: ${code(active.id)} · ${code(chatModelOf(active) ?? "provider default")}`
      : `No active text provider is configured (config names ${code(activeId)}).`,
  ];
  if (resolved.providers.length > 0) {
    lines.push("", "Providers:");
    for (const entry of resolved.providers) {
      const here = entry.id === activeId ? " (active)" : "";
      const keyless =
        KEY_REQUIRED_KINDS.has(entry.kind) && !hasApiKey(entry)
          ? " — no API key"
          : "";
      lines.push(
        `• ${code(entry.id)} · ${code(chatModelOf(entry) ?? "provider default")}${here}${keyless}`,
      );
    }
  }
  lines.push(
    "",
    `${code("/model <provider>")} switches provider; ${code("/model <provider> <model-id>")} pins a model on it.`,
  );
  return lines.join("\n");
}

/**
 * Write the provider/model stamp onto this chat's session and persist
 * it, and return the model that was stamped. Re-reads the config so the
 * stamp records what actually landed on disk (a provider switch with no
 * model argument keeps that provider's own model). No session yet means
 * nothing to stamp — the choice is the global default the chat's first
 * session will inherit anyway.
 */
function stampChatSession(
  chat: ModelCommandChat,
  providerId: string,
): string | null {
  const entry = resolveLlmConfig(getConfig()).providers.find(
    (p) => p.id === providerId,
  );
  const chatModel = entry ? chatModelOf(entry) : null;
  if (!chat.sessionId) return chatModel;
  const session = chat.runtime.sessionStore.load(chat.sessionId);
  if (!session) return chatModel;
  chat.runtime.sessionStore.save({
    ...session,
    metadata: {
      ...session.metadata,
      [SESSION_LLM_METADATA_KEY]: { providerId, chatModel },
    },
  });
  return chatModel;
}
