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
 * the TUI then shows, and the session stamp has to be the one the TUI
 * restores when it opens that session.
 *
 * The selection itself is **global**, because `llm.activeTextProvider`
 * is: there is no per-session provider today — `executeTurn` re-stamps
 * every session from the global config at the top of each turn. That is
 * why the in-flight guard below covers every session and not only the
 * issuing chat's.
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
 *
 * Two more refusals exist for the same reason — a chat has no undo, so
 * a write it cannot take back must not happen at all. A model id is
 * refused on a `llama-server` provider, whose factory never reads one
 * (see {@link MODEL_PIN_IGNORED_KINDS}), and a provider whose entry
 * declares an `apiKeyEnvVar` that is unset is refused even though its
 * kind is not in {@link KEY_REQUIRED_KINDS} (see {@link missingApiKey}).
 */

import type { AtomicAgentConfig } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import { LOCAL_PROVIDER_KIND } from "../config/llm-run-mode-config.js";
import type { RunModeName } from "../config/llm-run-mode-config.js";
import { resolveLlmProviderApiKey } from "../config/resolve-llm-api-key.js";
import {
  resolveLlmConfig,
  type LlmProviderConfigEntry,
  type ResolvedLlmConfig,
} from "../llm/provider/registry/index.js";
import {
  describeRunMode,
  resolveRunMode,
  runModeLabel,
  type ResolvedRunMode,
} from "../llm/run-mode/index.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { SESSION_LLM_METADATA_KEY } from "../session/index.js";
import {
  restoreProviderDefaultChatModelInConfig,
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
 * Provider kinds whose factory never reads `entry.defaultChatModel`, so
 * pinning a model on them changes no inference at all.
 *
 * `llama-server` is the only one (see `register-built-in-providers.ts`:
 * every other factory passes `entry.defaultChatModel` to the provider,
 * the llama-server factory does not — the daemon serves whichever GGUF
 * it was started with). Writing a model id onto such an entry is worse
 * than a no-op: `resolveActiveModelName()` in `bootstrap.ts` reads
 * `entry.defaultChatModel` *first*, ahead of
 * `localModels.managed.modelId`, so the pin would become the model name
 * in every `message_sent` event, in the cost lookup and in the TUI —
 * naming a model that is not running, with no way to clear it from a
 * chat. The TUI cannot reach that state either: `openChatModelPicker`
 * and `ensureInlineModels` both refuse non-cloud kinds. So neither can
 * this command.
 */
const MODEL_PIN_IGNORED_KINDS = new Set([LOCAL_PROVIDER_KIND]);

/**
 * Run `/model` and return the message to post.
 *
 * **Never throws**, and the guarantee is enforced here rather than
 * promised leg by leg: the whole command runs inside this one
 * `catch`, so a failure with no specific message of its own — the
 * entry `getConfig()` on a config that no longer parses, most of all —
 * still comes back as a message. The handlers that call this must not
 * let one bad command take the channel down: Discord's dispatch is a
 * bare `void this.onDispatch(...)` with no catch at all, so a rejection
 * here is an unhandled rejection there, and Telegram's chat gets no
 * reply of any kind.
 *
 * The legs that *do* have something better to say — a failed provider
 * reload, a failed session-store write, a post-switch config re-read —
 * still catch it themselves, inside {@link runModelCommandInner}. This
 * is the floor under them, not a replacement for them.
 */
export async function runModelCommand(
  args: readonly string[],
  chat: ModelCommandChat,
): Promise<string> {
  try {
    return await runModelCommandInner(args, chat);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      chat.runtime.logger.warn("model command failed", { error: message });
    } catch {
      // A logger that throws must not defeat the guarantee either.
    }
    // Deliberately undecorated: `chat.code` comes from the caller, and
    // the one path that must never throw is not the place to call it.
    return `Could not run /model: ${message}`;
  }
}

async function runModelCommandInner(
  args: readonly string[],
  chat: ModelCommandChat,
): Promise<string> {
  const config = getConfig();
  const resolved = resolveLlmConfig(config);
  if (args.length === 0) return formatReport(config, resolved, chat.code);

  const target = resolveTarget(args, config, resolved, chat.code);
  if (!target.ok) return target.message;

  // Same shape as `/switch`: the arguments are validated first so a
  // typo is answered as a typo, and only a command that would actually
  // change something is refused for being mid-turn.
  const busy = busyRefusal(chat);
  if (busy) return busy;

  const previousActiveId = resolved.activeTextProvider;
  const previousModelPin = resolved.providers.find(
    (p) => p.id === target.providerId,
  )?.defaultChatModel;
  const modeBefore = currentRunMode(config, resolved).effective;
  let pinned = false;
  let activated = false;
  try {
    if (target.modelId !== null) {
      setProviderDefaultChatModelInConfig(target.providerId, target.modelId);
      pinned = true;
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
    activated = true;
    setActiveTextProviderInConfig(target.providerId);
  } catch (err) {
    // "Could not switch" has to mean nothing switched. The model pin is
    // written first because rebuilding the provider reads it back off
    // disk, so a rebuild that then fails would otherwise leave the
    // config naming a model that was refused — and a later bare
    // `/model` would report it as the provider's model. Undo both legs
    // (config pin, in-memory active provider) before answering; each
    // undo swallows its own failure so a rollback error cannot mask the
    // real one.
    await rollback(chat, {
      providerId: target.providerId,
      previousActiveId,
      previousModelPin,
      pinned,
      activated,
    });
    return `Could not switch to ${chat.code(target.providerId)}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  // Stamp the chat's session now rather than waiting for `executeTurn`
  // to do it at the top of the next turn: a `/model` followed by a
  // `/switch` away would otherwise lose the choice before any turn ran,
  // and the TUI restores a session's stamped provider when it opens it
  // (`session-llm.ts`). The switch itself has already landed in the
  // config, so a session store that cannot write must not turn a
  // successful switch into no reply at all: log it and answer anyway.
  try {
    stampChatSession(chat, target.providerId);
  } catch (err) {
    chat.runtime.logger.warn("model command: session stamp failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Re-read: the reply has to describe what is now on disk, not what
  // the pre-switch snapshot said. Guarded because this function promises
  // its callers it never throws — Discord's dispatch is a bare
  // `void this.onDispatch(...)` — and the switch has already landed, so
  // a config that somehow no longer parses must degrade to the snapshot
  // rather than turn a success into an unhandled rejection.
  let after = config;
  let afterResolved = resolved;
  try {
    after = getConfig();
    afterResolved = resolveLlmConfig(after);
  } catch (err) {
    chat.runtime.logger.warn("model command: config re-read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const entry = afterResolved.providers.find((p) => p.id === target.providerId);
  // Active by construction: `setActive` + `setActiveTextProviderInConfig`
  // both landed above, so the managed-daemon leg of `displayModelOf`
  // applies to this entry the same way it applies in `bootstrap`.
  const shown = entry ? displayModelOf(entry, after, true) : null;
  // Clipped exactly as the report clips it, and for the same reason:
  // the model id here is whatever was just typed into the chat, so this
  // is the *most* likely message to carry a pathological one.
  const reply = `Now on ${chat.code(target.providerId)} · ${chat.code(
    shown === null ? "provider default" : clipName(shown),
  )}. Takes effect on the next message.`;
  const note = runModeChangeNote(
    modeBefore,
    currentRunMode(after, afterResolved),
    chat.code,
  );
  return note === null ? reply : `${reply}\n\n${note}`;
}

/** The run mode the live config resolves to, the way `bootstrap` does. */
function currentRunMode(
  config: AtomicAgentConfig,
  resolved: ResolvedLlmConfig,
): ResolvedRunMode {
  return resolveRunMode(resolved, {
    managedModelId: config.localModels.managed.modelId,
  });
}

/**
 * The line to append when a provider switch also moved the run mode, or
 * `null` when it did not.
 *
 * Switching the active provider by hand *is* how one leaves fusion —
 * `resolveRunMode` derives the effective mode from `activeTextProvider`
 * on purpose, so the two keys can never contradict each other, and the
 * TUI's own LLM pane drops out of fusion the same way. What the TUI has
 * and the channels did not is a place that says so: the run-mode chip.
 * Silently removing `fusion.delegate` and the `### fusion` guidance from
 * every session (`bootstrap.ts` gates the fan-out descriptor on
 * `effective === "fusion"`) is a large change to answer with "Now on
 * local-llama."
 *
 * Only fusion transitions are announced. Local ↔ Cloud is a change of
 * mode too, but it is the whole content of the request and the reply
 * already names the provider that caused it; a line restating it on
 * every ordinary switch would be noise that teaches operators to skip
 * the paragraph that matters.
 */
function runModeChangeNote(
  before: RunModeName,
  after: ResolvedRunMode,
  code: (text: string) => string,
): string | null {
  if (after.effective === before) return null;
  if (before !== "fusion" && after.effective !== "fusion") return null;
  const head = `Run mode: ${runModeLabel(before)} → ${runModeLabel(after.effective)}.`;
  if (before === "fusion") {
    const back = after.orchestratorProviderId;
    return `${head} ${code("fusion.delegate")} and its guidance are gone from every session${
      back === null
        ? ""
        : ` until ${code(back)} is active again — ${code(`/model ${back}`)} restores it`
    }.`;
  }
  // The two guards above leave exactly two shapes, and the branch just
  // taken was the first: `before` is not "fusion", so `after.effective`
  // is. No third case exists to fall through to.
  return `${head} ${code("fusion.delegate")} is back, with ${after.workers} worker${
    after.workers === 1 ? "" : "s"
  } on ${code(after.workerProviderId ?? "the local provider")}.`;
}

/**
 * The refusal for a turn that is already running, or `null` when
 * nothing is.
 *
 * This deliberately gates on **every** busy session, not just the
 * issuing chat's. `llm.activeTextProvider` is one global setting and
 * `bootstrap`'s `resolveActiveLlmSlice` re-resolves it *per inference
 * attempt* ("Re-read on every inference so TUI `setActive` hot-swap
 * takes effect"), returning the transport and tool-call adapter with
 * it. So a switch while any other session is mid-turn does not wait for
 * that session's next turn — it lands on its very next step, changing
 * the model and possibly the tool transport (native_tools <-> grammar)
 * underneath a turn already in flight. Concurrent sessions are the
 * normal case here: Telegram is per-chat, Discord per-channel, and the
 * TUI, the HTTP route and the scheduler all submit through the same
 * `turnController`.
 *
 * The cost is that a long scheduled task blocks `/model`; the message
 * names the count so the operator knows to wait or `/cancel`.
 */
function busyRefusal(chat: ModelCommandChat): string | null {
  const busy = chat.runtime.turnController.busySessionIds();
  if (busy.length === 0) return null;
  const own = chat.sessionId !== null && busy.includes(chat.sessionId);
  if (own && busy.length === 1) {
    return "This chat has a turn in progress; try /model again when it finishes.";
  }
  const others = busy.filter((id) => id !== chat.sessionId).length;
  const where = own
    ? `this chat and ${others} other session${others === 1 ? "" : "s"}`
    : `${others} other session${others === 1 ? "" : "s"}`;
  return `A turn is in progress on ${where}. The provider is shared, so switching now would change what those turns run on at their next step — try /model again when they finish, or /cancel.`;
}

/**
 * Undo whichever legs of a switch landed before it failed. Every step
 * swallows its own error: this runs inside a `catch` whose job is to
 * report the *original* failure, and a rollback that throws would
 * replace it with a less useful one.
 */
async function rollback(
  chat: ModelCommandChat,
  state: {
    providerId: string;
    previousActiveId: string;
    previousModelPin: string | undefined;
    pinned: boolean;
    activated: boolean;
  },
): Promise<void> {
  if (state.pinned) {
    try {
      restoreProviderDefaultChatModelInConfig(
        state.providerId,
        state.previousModelPin,
      );
      // The registry may have been rebuilt from the rejected pin; put
      // its copy back in step with the config too.
      if (chat.runtime.providerRegistry.listIds().includes(state.providerId)) {
        await chat.runtime.reloadLlmProvider(state.providerId);
      }
    } catch {
      // Reported failure stands; nothing better to say here.
    }
  }
  if (state.activated && state.previousActiveId !== state.providerId) {
    try {
      await chat.runtime.providerRegistry.setActive(state.previousActiveId);
    } catch {
      // As above.
    }
  }
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
  config: AtomicAgentConfig,
  resolved: ResolvedLlmConfig,
  code: (text: string) => string,
): ResolvedTarget {
  // Refuse rather than ignore the tail. A third word is always a
  // mistake — a provider id and a model id are one token each, and
  // silently dropping the rest would accept `/model openrouter gpt-4
  // please` as a pin of `gpt-4` while the operator believes something
  // else was said.
  if (args.length > 2) {
    return {
      ok: false,
      message: `Too many arguments. Usage: ${code("/model <provider> <model-id>")}.`,
    };
  }
  const first = args[0] ?? "";
  const [token, inlineModel] =
    args.length > 1 ? [first, args[1] ?? null] : splitAtFirstSlash(first);

  // A leading slash (`/vendor/model-9` — a bare model id typed with its
  // vendor prefix) splits into an empty provider. Answer the shape of
  // the command rather than "Unknown provider ", which names nothing.
  if (token.length === 0) {
    return {
      ok: false,
      message: `A model id has to name its provider: ${code("/model <provider> <model-id>")}.`,
    };
  }

  const match = matchProvider(token, resolved.providers);
  if (match.kind === "none") {
    const ids = joinIds(
      resolved.providers.map((p) => p.id),
      code,
    );
    return {
      ok: false,
      message: [
        `Unknown provider ${code(clipName(token))}.`,
        ids.length > 0 ? `Configured: ${ids}.` : "No providers are configured.",
        `A model id has to name its provider: ${code("/model <provider> <model-id>")}.`,
      ].join(" "),
    };
  }
  if (match.kind === "ambiguous") {
    // Fitted to a character budget rather than an entry count: this is
    // the one message whose whole job is "say which one", so hiding a
    // candidate that would have fitted removes the very information it
    // asks the operator to act on. See {@link MAX_AMBIGUOUS_LIST_CHARS}.
    const fitted = fitIds(match.ids, code, {
      maxChars: MAX_AMBIGUOUS_LIST_CHARS,
    });
    const listed =
      fitted.hidden === 0
        ? fitted.text
        : `${fitted.text} and ${fitted.hidden} more`;
    return {
      ok: false,
      message: `${code(clipName(token))} matches ${listed} — say which one${
        fitted.hidden === 0 ? "" : ", or type more of the id to narrow the list"
      }.`,
    };
  }

  const entry = match.entry;
  const missingKey = missingApiKey(entry, config);
  if (missingKey) {
    return {
      ok: false,
      message: `Provider ${code(entry.id)} has no API key configured${
        missingKey.envVar === null
          ? ""
          : ` (${code(clipName(missingKey.envVar))} is unset)`
      }; add one in the TUI's LLM tab before switching to it.`,
    };
  }
  const modelId = inlineModel === null ? null : inlineModel.trim();
  if (modelId !== null && modelId.length === 0) {
    return {
      ok: false,
      message: `Usage: ${code("/model <provider> <model-id>")}.`,
    };
  }
  if (modelId !== null && MODEL_PIN_IGNORED_KINDS.has(entry.kind)) {
    return {
      ok: false,
      message: [
        `${code(entry.id)} is a local ${code(entry.kind)} provider: it serves whichever model its daemon loaded, and nothing reads a model id off its config entry.`,
        `Pinning ${code(clipName(modelId))} would rename it everywhere — reports, analytics, cost — without changing what runs, and no chat command could undo that.`,
        `Use ${code(`/model ${entry.id}`)} to switch to it; pick the local model in the TUI's Local Models tab.`,
      ].join(" "),
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

/**
 * Why `providerId` cannot authenticate, or `null` when it can (or does
 * not need to).
 *
 * Two reasons, and the second is the one a kind check alone misses. The
 * known-service presets — Groq, Nous, Anthropic and friends — are all
 * stored as `kind: "openai-compatible"` with their own `apiKeyEnvVar`
 * (`providers-wizard-build-entry.ts`), so keying only on kind reports
 * them as usable and switches to them happily while
 * `resolveLlmProviderApiKey` returns `undefined`; every following turn
 * then 401s with nothing in the channel to explain it. An entry that
 * *declares* an env var has said it needs a key, which is exactly the
 * signal that separates it from a bare keyless compat entry (LM Studio,
 * Ollama) that must keep working.
 *
 * `apiKeyEnvVar` lives on the user-config entry rather than on
 * `LlmProviderConfigEntry`, so it is read off the file entry here.
 */
function missingApiKey(
  entry: LlmProviderConfigEntry,
  config: AtomicAgentConfig,
): { envVar: string | null } | null {
  if (hasApiKey(entry)) return null;
  const envVar = config.llm?.providers.find(
    (e) => e.id === entry.id,
  )?.apiKeyEnvVar;
  if (envVar !== undefined && envVar.length > 0) return { envVar };
  return KEY_REQUIRED_KINDS.has(entry.kind) ? { envVar: null } : null;
}

/**
 * The chat model an entry *pins*, or `null` when it names none.
 *
 * This is the switch-and-stamp value, deliberately not the display one:
 * `executeTurn` stamps sessions with exactly this expression, and a
 * stamp carrying a model on a `llama-server` entry would make the TUI's
 * session restore call `selectChatModel` on reopen
 * (`session-model-restore.ts`), writing that id into
 * `defaultChatModel` — the poisoning `MODEL_PIN_IGNORED_KINDS` exists
 * to prevent. Use {@link displayModelOf} for anything an operator reads.
 */
function chatModelOf(entry: LlmProviderConfigEntry): string | null {
  return entry.defaultChatModel ?? entry.model ?? null;
}

/**
 * The model to *show* for an entry: its pin when it has one, and — for
 * the **active** local `llama-server` — the managed daemon's GGUF id,
 * which is what it actually serves.
 *
 * Same first legs and same order as `resolveActiveModelName()` in
 * `bootstrap.ts`, so the channel reports the model the cost lookup and
 * the `message_sent` events report. That parity is the whole
 * justification for the `localModels` leg, and it only holds for the
 * active entry: `bootstrap` computes that name for
 * `resolved.activeTextProvider` alone, while the report walks every
 * configured provider. `localModels.managed` describes *one* daemon —
 * the managed one this install starts — so attributing its GGUF id to
 * a second `llama-server` entry (a box on the LAN, say; `resolve-run-
 * mode.ts` picks the worker leg with a `find`, so more than one is a
 * shape the code expects) would report it as running a model it has
 * never seen. A non-active local entry therefore reads as "provider
 * default", which is the truth: nothing in the config says what it
 * serves.
 *
 * `isActive` is passed in rather than re-derived so the post-switch
 * reply — where the entry is active by construction — and the report
 * cannot disagree about which entry that is.
 *
 * The legs `resolveActiveModelName` has and this does not are the
 * operator `--alias` and the prompt-profile id, neither of which is
 * reachable from config alone. The one thing this shares with it and
 * would be wrong to "fix" here is that neither consults
 * `localModels.mode`: an external-mode daemon with a managed id left
 * over from an earlier download reads as that id in both places. Gating
 * on the mode would make the channel disagree with the model name in
 * every `message_sent` event and in the cost lookup, which is a worse
 * failure than the stale id and belongs upstream in `bootstrap` if it
 * is to be fixed at all.
 */
function displayModelOf(
  entry: LlmProviderConfigEntry,
  config: AtomicAgentConfig,
  isActive: boolean,
): string | null {
  const pinned = chatModelOf(entry);
  if (pinned !== null) return pinned;
  if (isActive && entry.kind === LOCAL_PROVIDER_KIND) {
    return config.localModels.managed.modelId ?? null;
  }
  return null;
}

/**
 * Longest an unbounded name prints before it is clipped.
 *
 * Only the names the config schema does not already bound need this: a
 * model id and an `apiKeyEnvVar` are `parseOptionalString`, so they are
 * any non-empty string, and the token in `/model <token>` is whatever
 * was typed into the chat. A *provider id* is not among them —
 * `PROVIDER_ID_RE` in `llm-config.ts` caps it at 32 kebab-case
 * characters — so ids print whole and clipping one would be dead code.
 *
 * 48 is generous enough that no realistic model id is touched
 * (`openrouter/auto` is 15, and the vendor-namespaced ids the gateways
 * use run to about 30) and short enough that one pathological entry
 * cannot eat the whole message.
 */
const MAX_NAME_CHARS = 48;

/**
 * How long the provider report may get, in characters.
 *
 * A chat message is not a terminal pane. Discord splits at 2000
 * characters (`DISCORD_MESSAGE_LIMIT`, and `DiscordApi.sendMessage`
 * chunks silently), Telegram at 4096 (`outbound-sender.ts`), so an
 * uncapped enumeration turns one answer into several messages — the
 * heading in one, the active provider stranded in another, and on
 * Telegram a chunk that a second 429 drops entirely. An install with a
 * dozen `openai-compatible` entries is enough to cross the Discord
 * limit. So the enumeration — the only unbounded part of the report —
 * is fitted to a budget under the tighter of the two limits, and what
 * does not fit is counted rather than printed. Nothing is lost by
 * that: the active provider is named on the first line either way, and
 * a provider that is not listed can still be switched to by name.
 */
const MAX_REPORT_CHARS = 1800;

/** Room kept for the "…and N more" trailer while fitting the list. */
const TRAILER_RESERVE_CHARS = 140;

/** `text`, shortened to {@link MAX_NAME_CHARS} with a visible ellipsis. */
function clipName(text: string): string {
  if (text.length <= MAX_NAME_CHARS) return text;
  return `${text.slice(0, MAX_NAME_CHARS - 1)}…`;
}

/**
 * Most provider ids the **unknown-provider** refusal enumerates before
 * it starts counting.
 *
 * That list is orientation, not a menu: the token matched nothing, so
 * what the refusal has to teach is the *form* of the command plus
 * enough real ids to recognise the shape of one. A dozen does that on
 * any install, and keeps a hundred-entry config from turning a typo
 * into the longest message the bot ever sends.
 */
const MAX_LISTED_IDS = 12;

/**
 * Characters the **ambiguous-prefix** refusal may spend on its
 * candidate list.
 *
 * Fitted by size and not by count, because unlike the list above these
 * ids *are* the answer: the sentence asks the operator to pick one, and
 * a candidate that was hidden cannot be picked — there is no way to
 * page through them from a chat. So everything that fits in one message
 * is printed. `PROVIDER_ID_RE` caps an id at 32 characters, so 1500
 * holds at least 40 of the longest ids that can exist and about 75
 * realistic ones, while leaving the rest of the sentence room under
 * Discord's 2000. Past that the count appears — and then the message
 * also says the one thing that shortens the list, which is typing more
 * of the id.
 */
const MAX_AMBIGUOUS_LIST_CHARS = 1500;

/**
 * Decorated provider ids fitted to a limit, and how many did not fit.
 *
 * `maxIds` caps the entries, `maxChars` the printed length; either may
 * be omitted. At least one id is always listed when there is one —
 * a budget too small for even a single entry would otherwise render as
 * "matches  and 3 more", which names nothing at all.
 */
function fitIds(
  ids: readonly string[],
  code: (text: string) => string,
  limit: { maxIds?: number; maxChars?: number },
): { text: string; hidden: number } {
  const maxIds = limit.maxIds ?? ids.length;
  const maxChars = limit.maxChars ?? Number.POSITIVE_INFINITY;
  const listed: string[] = [];
  let used = 0;
  for (const id of ids) {
    if (listed.length >= maxIds) break;
    const piece = code(id);
    const cost = piece.length + (listed.length === 0 ? 0 : 2);
    if (listed.length > 0 && used + cost > maxChars) break;
    listed.push(piece);
    used += cost;
  }
  return { text: listed.join(", "), hidden: ids.length - listed.length };
}

/**
 * Decorated, comma-joined provider ids for the unknown-provider
 * refusal, capped at {@link MAX_LISTED_IDS} with the overflow counted.
 */
function joinIds(
  ids: readonly string[],
  code: (text: string) => string,
): string {
  const { text, hidden } = fitIds(ids, code, { maxIds: MAX_LISTED_IDS });
  return hidden > 0 ? `${text} and ${hidden} more` : text;
}

/** One `• id · model (active) — no API key (VAR is unset)` line. */
function providerLine(
  entry: LlmProviderConfigEntry,
  config: AtomicAgentConfig,
  activeId: string,
  code: (text: string) => string,
): string {
  const here = entry.id === activeId ? " (active)" : "";
  const missing = missingApiKey(entry, config);
  const keyless =
    missing === null
      ? ""
      : missing.envVar === null
        ? " — no API key"
        : ` — no API key (${clipName(missing.envVar)} is unset)`;
  const model = displayModelOf(entry, config, entry.id === activeId);
  return `• ${code(entry.id)} · ${code(
    model === null ? "provider default" : clipName(model),
  )}${here}${keyless}`;
}

function formatReport(
  config: AtomicAgentConfig,
  resolved: ResolvedLlmConfig,
  code: (text: string) => string,
): string {
  const activeId = resolved.activeTextProvider;
  const active = resolved.providers.find((p) => p.id === activeId);
  const activeModel = active ? displayModelOf(active, config, true) : null;
  const lines = [
    active
      ? `Model: ${code(active.id)} · ${code(
          activeModel === null ? "provider default" : clipName(activeModel),
        )}`
      : `No active text provider is configured (config names ${code(activeId)}).`,
    // The run mode is not cosmetic here: it decides whether
    // `fusion.delegate` and the `### fusion` guidance are in the
    // session at all, and switching provider is what turns it off.
    // The TUI has a chip for this; the channels have this line.
    `Run mode: ${describeRunMode(currentRunMode(config, resolved))}`,
  ];
  const foot = `${code("/model <provider>")} switches provider; ${code("/model <provider> <model-id>")} pins a model on it.`;
  if (resolved.providers.length > 0) {
    lines.push("", "Providers:");
    // The active entry's line is budgeted up front and emitted wherever
    // it falls in the list, so a long install cannot produce a report
    // that omits the one provider it is reporting on. Everything above
    // plus the footer is committed too; only the rest is fitted.
    const activeLine = active
      ? providerLine(active, config, activeId, code)
      : null;
    let used =
      lines.join("\n").length +
      1 +
      foot.length +
      1 +
      (activeLine === null ? 0 : activeLine.length + 1);
    let shown = 0;
    for (const entry of resolved.providers) {
      if (activeLine !== null && entry.id === activeId) {
        lines.push(activeLine);
        shown += 1;
        continue;
      }
      const line = providerLine(entry, config, activeId, code);
      // The trailer's room is always kept rather than predicted: at
      // worst that costs one line on a report that turns out not to
      // need one, and predicting it wrong costs a split message.
      if (used + line.length + 1 + TRAILER_RESERVE_CHARS > MAX_REPORT_CHARS) {
        continue;
      }
      lines.push(line);
      used += line.length + 1;
      shown += 1;
    }
    const hidden = resolved.providers.length - shown;
    if (hidden > 0) {
      lines.push(
        `…and ${hidden} more not shown — ${code("/model <provider>")} switches to any of them, listed or not.`,
      );
    }
  }
  lines.push("", foot);
  return lines.join("\n");
}

/**
 * Write the provider/model stamp onto this chat's session and persist
 * it. Re-reads the config so the stamp records what actually landed on
 * disk (a provider switch with no model argument keeps that provider's
 * own model), and uses {@link chatModelOf} rather than
 * {@link displayModelOf} so the stamp stays byte-identical to the one
 * `executeTurn` writes. No session yet means nothing to stamp — the
 * choice is the global default the chat's first session will inherit
 * anyway.
 */
function stampChatSession(chat: ModelCommandChat, providerId: string): void {
  const entry = resolveLlmConfig(getConfig()).providers.find(
    (p) => p.id === providerId,
  );
  const chatModel = entry ? chatModelOf(entry) : null;
  if (!chat.sessionId) return;
  const session = chat.runtime.sessionStore.load(chat.sessionId);
  if (!session) return;
  chat.runtime.sessionStore.save({
    ...session,
    metadata: {
      ...session.metadata,
      [SESSION_LLM_METADATA_KEY]: { providerId, chatModel },
    },
  });
}
