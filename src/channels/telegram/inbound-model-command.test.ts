/**
 * `/model` over Telegram, end to end through `handleInboundText`.
 *
 * Nothing here is mocked: the command writes the real user config in an
 * isolated `ATOMIC_AGENT_STATE_DIR`, which is the point — the whole
 * feature is "the chat writes the same state the TUI writes", so a test
 * against a stubbed config writer would prove nothing about that.
 *
 * The isolation is deliberate and total: the state dir *and* the API-key
 * environment variables the report reads are both controlled here, so
 * the outcome cannot depend on whether whoever runs the suite happens to
 * have `OPENROUTER_API_KEY` exported.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../../config/config-cache.js";
import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../../config/config-schema.js";
import { getConfig } from "../../config/index.js";
import { ProviderRegistry } from "../../llm/provider/registry/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import {
  createEmptySessionState,
  readSessionLlmStamp,
  type SessionState,
} from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createAttachmentInbox } from "../attachments/inbox.js";
import { handleInboundText, type InboundContext } from "./inbound-handler.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

const OWNER = 42;
const CHAT = 100;
const CHAT_KEY = String(CHAT);

/**
 * Every variable `resolveLlmProviderApiKey` consults for the provider
 * kinds in the fixture below. Cleared before each test and restored
 * after, so an ambient key cannot flip a "no API key" assertion.
 */
const API_KEY_ENV = [
  "OPENROUTER_API_KEY",
  "AIMLAPI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
] as const;

function writeLlmConfig(stateDir: string): void {
  writeUserConfigFileSync(getUserConfigPath(stateDir), {
    ...USER_CONFIG_DEFAULTS,
    llm: {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto",
      providers: [
        {
          id: "local-llama",
          kind: "llama-server",
          url: "http://127.0.0.1:19091",
        },
        {
          id: "openrouter",
          kind: "openrouter",
          defaultChatModel: "openrouter/auto",
        },
        // `baseUrl` and `defaultChatModel` are not decoration: an
        // `openai-compatible` entry without them is refused by
        // `register-built-in-providers.ts`, so a fixture missing them
        // would only ever "switch" because `reloadLlmProviders` is
        // stubbed. The registry test below builds this same config for
        // real to keep that honest.
        {
          id: "openai-compat",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:1234/v1",
          defaultChatModel: "gpt-x",
        },
      ],
    },
  });
  resetConfigCache();
}

function makeRuntime(sessions: SessionState[]) {
  const busy = new Set<string>();
  const saved: SessionState[] = [];
  const reloaded: string[] = [];
  const activated: string[] = [];
  /** Injectable failures for the two steps that talk to the world. */
  const failures: { reload: Error | null; save: Error | null } = {
    reload: null,
    save: null,
  };
  const runtime = {
    createSession: () => sessions[0],
    logger: new StructuredLogger({ level: "warn", sinks: [] }),
    sessionStore: {
      load: (id: string) => sessions.find((s) => s.id === id) ?? null,
      save: (state: SessionState) => {
        if (failures.save) throw failures.save;
        saved.push(state);
        const at = sessions.findIndex((s) => s.id === state.id);
        if (at >= 0) sessions[at] = state;
      },
    },
    turnController: {
      isBusy: (id: string) => busy.has(id),
      busySessionIds: () => [...busy],
    },
    providerRegistry: {
      listIds: () => ["local-llama", "openrouter"],
      setActive: vi.fn(async (id: string) => {
        activated.push(id);
        return {};
      }),
    },
    reloadLlmProvider: vi.fn(async (id: string) => {
      if (failures.reload) throw failures.reload;
      reloaded.push(id);
    }),
    reloadLlmProviders: vi.fn(async () => {
      if (failures.reload) throw failures.reload;
      reloaded.push("*");
    }),
    runTurn: async () => ({ session: sessions[0], reason: "reply" as const }),
  } as unknown as AgentRuntime;
  return { runtime, busy, saved, reloaded, activated, failures };
}

describe("/model over Telegram", () => {
  let stateDir: string;
  let dir: string;
  let pointer: TelegramSessionPointer;
  let sent: string[];
  let ctx: InboundContext;
  let session: SessionState;
  let fake: ReturnType<typeof makeRuntime>;
  let savedEnv: Array<[string, string | undefined]>;

  beforeEach(() => {
    savedEnv = API_KEY_ENV.map((name) => [name, process.env[name]]);
    for (const name of API_KEY_ENV) delete process.env[name];

    stateDir = mkdtempSync(join(tmpdir(), "atomic-tg-model-state-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    writeLlmConfig(stateDir);

    dir = mkdtempSync(join(tmpdir(), "atomic-tg-model-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
    session = createEmptySessionState({ id: "s-1", workingDir: "/tmp/test" });
    pointer.setCurrent(CHAT_KEY, session.id, "DM");
    fake = makeRuntime([session]);
    sent = [];
    ctx = {
      runtime: fake.runtime,
      api: {
        sendMessage: vi.fn(async (_chatId: number, text: string) => {
          sent.push(text);
          return { message_id: sent.length };
        }),
      },
      sessionPointer: pointer,
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      ownerUserId: OWNER,
      inflight: new Map(),
      inbox: createAttachmentInbox({ dir: join(dir, "inbox") }),
      mediaGroups: new Map(),
      scheduleKeepalive: () => () => undefined,
    } as unknown as InboundContext;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigCache();
  });

  async function say(text: string): Promise<void> {
    await handleInboundText(
      {
        from: { id: OWNER },
        chat: { id: CHAT, type: "private" },
        text,
        message_id: 1,
      },
      ctx,
    );
  }

  it("reports the active provider and every configured one", async () => {
    await say("/model");
    expect(sent).toHaveLength(1);
    const [report = ""] = sent;
    expect(report).toContain("Model: local-llama · provider default");
    expect(report).toContain("• openrouter · openrouter/auto");
    expect(report).toContain("• local-llama · provider default (active)");
    // Cleared in `beforeEach`, so this is the fixture's verdict and not
    // the developer's environment.
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(report).toContain("no API key");
    // Plain text on Telegram: the id decoration must not leak backticks.
    expect(report).not.toContain("`");
  });

  it("pins a model on a provider, activates it, and stamps the session", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    await say("/model openrouter anthropic/claude-opus-4");
    expect(sent).toEqual([
      "Now on openrouter · anthropic/claude-opus-4. Takes effect on the next message.",
    ]);
    // The config the TUI reads is the config that changed.
    const llm = getConfig().llm;
    expect(llm?.activeTextProvider).toBe("openrouter");
    expect(
      llm?.providers.find((p) => p.id === "openrouter")?.defaultChatModel,
    ).toBe("anthropic/claude-opus-4");
    // Rebuilt before it was made active, and only that provider.
    expect(fake.reloaded).toEqual(["openrouter"]);
    expect(fake.activated).toEqual(["openrouter"]);
    // The stamp is what the TUI reads back when it opens this session.
    expect(readSessionLlmStamp(fake.saved.at(-1)?.metadata)).toEqual({
      providerId: "openrouter",
      chatModel: "anthropic/claude-opus-4",
    });
  });

  it("accepts the one-token form and splits at the first slash", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    await say("/model openrouter/vendor/model-9");
    expect(
      getConfig().llm?.providers.find((p) => p.id === "openrouter")
        ?.defaultChatModel,
    ).toBe("vendor/model-9");
  });

  it("refuses an unknown provider and names the configured ones", async () => {
    await say("/model gpt-5.4-mini");
    expect(sent[0]).toContain("Unknown provider gpt-5.4-mini.");
    expect(sent[0]).toContain(
      "Configured: local-llama, openrouter, openai-compat.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("names the command's shape for a token that begins with a slash", async () => {
    // `/model /vendor/model-9` splits into an empty provider; the old
    // wording was "Unknown provider ." and named nothing at all.
    await say("/model /vendor/model-9");
    expect(sent[0]).toBe(
      "A model id has to name its provider: /model <provider> <model-id>.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("refuses trailing arguments instead of ignoring them", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    await say("/model openrouter m-1 junk more");
    expect(sent[0]).toBe(
      "Too many arguments. Usage: /model <provider> <model-id>.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
    expect(
      getConfig().llm?.providers.find((p) => p.id === "openrouter")
        ?.defaultChatModel,
    ).toBe("openrouter/auto");
  });

  it("refuses an ambiguous prefix", async () => {
    await say("/model open");
    expect(sent[0]).toBe(
      "open matches openrouter, openai-compat — say which one.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("refuses a provider whose API key is missing", async () => {
    await say("/model openrouter");
    expect(sent[0]).toContain("has no API key configured");
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("refuses while this chat has a turn in progress", async () => {
    fake.busy.add(session.id);
    await say("/model openai-compat");
    expect(sent[0]).toBe(
      "This chat has a turn in progress; try /model again when it finishes.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("refuses while ANOTHER session has a turn in progress", async () => {
    // The active provider is global and re-resolved per inference
    // attempt, so a switch now would land on another session's very
    // next step — not its next turn.
    fake.busy.add("s-other");
    await say("/model openai-compat");
    expect(sent[0]).toContain("A turn is in progress on 1 other session.");
    expect(sent[0]).toContain("at their next step");
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("switches provider without touching its pinned model", async () => {
    await say("/model openai-compat");
    expect(sent[0]).toBe(
      "Now on openai-compat · gpt-x. Takes effect on the next message.",
    );
    // Not in the registry yet, so the whole set is merged rather than
    // one entry replaced.
    expect(fake.reloaded).toEqual(["*"]);
    expect(getConfig().llm?.activeTextProvider).toBe("openai-compat");
  });

  it("uses a provider config the real registry can actually build", async () => {
    // `reloadLlmProviders` is stubbed above — the one mocked seam in an
    // otherwise unmocked test — so build the same config for real once.
    // Without this, the "not yet in the registry" test would keep
    // passing for a config production refuses.
    const registry = await ProviderRegistry.fromConfig(getConfig(), {
      config: getConfig(),
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      llamaClient: {} as never,
      getProfile: (() => {
        throw new Error("no inference runs in this test");
      }) as never,
    });
    expect([...registry.listIds()]).toEqual([
      "local-llama",
      "openrouter",
      "openai-compat",
    ]);
  });

  it("leaves no half-written config when the provider reload fails", async () => {
    fake.failures.reload = new Error("llama-server unreachable");
    await say("/model openai-compat brand-new-model");
    expect(sent[0]).toBe(
      "Could not switch to openai-compat: llama-server unreachable",
    );
    const llm = getConfig().llm;
    expect(llm?.activeTextProvider).toBe("local-llama");
    // "Could not switch" has to mean nothing switched: a later bare
    // `/model` must not report the model that was just rejected.
    expect(
      llm?.providers.find((p) => p.id === "openai-compat")?.defaultChatModel,
    ).toBe("gpt-x");
  });

  it("clears a pin that did not exist before when the reload fails", async () => {
    fake.failures.reload = new Error("nope");
    await say("/model local-llama some-model");
    expect(sent[0]).toBe("Could not switch to local-llama: nope");
    // The config parser always materialises the key, so assert the
    // value: the rollback has to leave it unset, not set to the id the
    // reload refused.
    expect(
      getConfig().llm?.providers.find((p) => p.id === "local-llama")
        ?.defaultChatModel,
    ).toBeUndefined();
  });

  it("still answers when the session store cannot save the stamp", async () => {
    fake.failures.save = new Error("ENOSPC");
    await say("/model openai-compat");
    // The config write already landed; a failed stamp must not turn a
    // successful switch into no reply at all.
    expect(sent).toEqual([
      "Now on openai-compat · gpt-x. Takes effect on the next message.",
    ]);
    expect(getConfig().llm?.activeTextProvider).toBe("openai-compat");
  });

  it("lists /model in the help text", async () => {
    await say("/help");
    expect(sent[0]).toContain("/model");
  });

  it("is not reachable by a non-owner", async () => {
    await handleInboundText(
      {
        from: { id: 99 },
        chat: { id: CHAT, type: "private" },
        text: "/model openai-compat",
        message_id: 2,
      },
      ctx,
    );
    expect(sent).toHaveLength(0);
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });
});
