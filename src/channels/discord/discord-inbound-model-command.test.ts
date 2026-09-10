/**
 * `/model` over Discord, end to end through `handleDiscordMessage`.
 *
 * The Telegram twin of this file is
 * `../telegram/inbound-model-command.test.ts`; the two are kept
 * deliberately parallel, because the two handlers are. Nothing is
 * mocked here either: the command writes the real user config in an
 * isolated `ATOMIC_AGENT_STATE_DIR`, and the API-key environment
 * variables are cleared per test so an ambient key cannot decide the
 * outcome of a "no API key" assertion.
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
import {
  handleDiscordMessage,
  type DiscordInboundContext,
} from "./discord-inbound-handler.js";
import { DiscordSessionPointer } from "./discord-session-pointer.js";

const OWNER = "111";
const BOT = "999";
const CHANNEL = "c-1";

/** Same list, and same reason, as the Telegram twin. */
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
        // An `openai-compatible` entry without `baseUrl` and
        // `defaultChatModel` is refused by the real registry, so the
        // fixture carries both and the registry test below proves it.
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

describe("/model over Discord", () => {
  let stateDir: string;
  let dir: string;
  let sent: string[];
  let ctx: DiscordInboundContext;
  let session: SessionState;
  let fake: ReturnType<typeof makeRuntime>;
  let savedEnv: Array<[string, string | undefined]>;

  beforeEach(() => {
    savedEnv = API_KEY_ENV.map((name) => [name, process.env[name]]);
    for (const name of API_KEY_ENV) delete process.env[name];

    stateDir = mkdtempSync(join(tmpdir(), "atomic-dc-model-state-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    writeLlmConfig(stateDir);

    dir = mkdtempSync(join(tmpdir(), "atomic-dc-model-"));
    const pointer = new DiscordSessionPointer(
      join(dir, "discord-session.json"),
    );
    session = createEmptySessionState({ id: "s-1", workingDir: "/tmp/test" });
    pointer.setCurrent(CHANNEL, session.id, "DM");
    fake = makeRuntime([session]);
    sent = [];
    ctx = {
      runtime: fake.runtime,
      api: {
        sendMessage: vi.fn(async (_channelId: string, text: string) => {
          sent.push(text);
          return "m1";
        }),
      },
      sessionPointer: pointer,
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      ownerUserIds: [OWNER],
      botUserId: BOT,
      inflight: new Map(),
      inbox: createAttachmentInbox({ dir: join(dir, "inbox") }),
    } as unknown as DiscordInboundContext;
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

  async function say(content: string, authorId: string = OWNER): Promise<void> {
    await handleDiscordMessage(
      {
        id: "m",
        channel_id: CHANNEL,
        content,
        author: { id: authorId },
      },
      ctx,
    );
  }

  it("reports the active provider and every configured one", async () => {
    await say("/model");
    expect(sent).toHaveLength(1);
    const [report = ""] = sent;
    expect(report).toContain("Model: `local-llama` · `provider default`");
    expect(report).toContain("• `openrouter` · `openrouter/auto`");
    expect(report).toContain("• `local-llama` · `provider default` (active)");
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(report).toContain("no API key");
  });

  it("pins a model on a provider, activates it, and stamps the session", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    await say("/model openrouter anthropic/claude-opus-4");
    expect(sent).toEqual([
      "Now on `openrouter` · `anthropic/claude-opus-4`. Takes effect on the next message.",
    ]);
    const llm = getConfig().llm;
    expect(llm?.activeTextProvider).toBe("openrouter");
    expect(
      llm?.providers.find((p) => p.id === "openrouter")?.defaultChatModel,
    ).toBe("anthropic/claude-opus-4");
    expect(fake.reloaded).toEqual(["openrouter"]);
    expect(fake.activated).toEqual(["openrouter"]);
    expect(readSessionLlmStamp(fake.saved.at(-1)?.metadata)).toEqual({
      providerId: "openrouter",
      chatModel: "anthropic/claude-opus-4",
    });
  });

  it("refuses an unknown provider and names the configured ones", async () => {
    await say("/model gpt-5.4-mini");
    expect(sent[0]).toContain("Unknown provider `gpt-5.4-mini`.");
    expect(sent[0]).toContain(
      "Configured: `local-llama`, `openrouter`, `openai-compat`.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("names the command's shape for a token that begins with a slash", async () => {
    await say("/model /vendor/model-9");
    expect(sent[0]).toBe(
      "A model id has to name its provider: `/model <provider> <model-id>`.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("refuses trailing arguments instead of ignoring them", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    await say("/model openrouter m-1 junk more");
    expect(sent[0]).toBe(
      "Too many arguments. Usage: `/model <provider> <model-id>`.",
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
      "`open` matches `openrouter`, `openai-compat` — say which one.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("refuses a provider whose API key is missing", async () => {
    await say("/model openrouter");
    expect(sent[0]).toContain("has no API key configured");
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("refuses while this channel has a turn in progress", async () => {
    fake.busy.add(session.id);
    await say("/model openai-compat");
    expect(sent[0]).toBe(
      "This chat has a turn in progress; try /model again when it finishes.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("refuses while ANOTHER session has a turn in progress", async () => {
    fake.busy.add("s-other");
    await say("/model openai-compat");
    expect(sent[0]).toContain("A turn is in progress on 1 other session.");
    expect(sent[0]).toContain("at their next step");
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("switches provider without touching its pinned model", async () => {
    await say("/model openai-compat");
    expect(sent[0]).toBe(
      "Now on `openai-compat` · `gpt-x`. Takes effect on the next message.",
    );
    expect(fake.reloaded).toEqual(["*"]);
    expect(getConfig().llm?.activeTextProvider).toBe("openai-compat");
  });

  it("uses a provider config the real registry can actually build", async () => {
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
      "Could not switch to `openai-compat`: llama-server unreachable",
    );
    const llm = getConfig().llm;
    expect(llm?.activeTextProvider).toBe("local-llama");
    expect(
      llm?.providers.find((p) => p.id === "openai-compat")?.defaultChatModel,
    ).toBe("gpt-x");
  });

  it("clears a pin that did not exist before when the reload fails", async () => {
    fake.failures.reload = new Error("nope");
    await say("/model local-llama some-model");
    expect(sent[0]).toBe("Could not switch to `local-llama`: nope");
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
    expect(sent).toEqual([
      "Now on `openai-compat` · `gpt-x`. Takes effect on the next message.",
    ]);
    expect(getConfig().llm?.activeTextProvider).toBe("openai-compat");
  });

  it("lists /model in the help text", async () => {
    await say("/help");
    expect(sent[0]).toContain("`/model`");
  });

  it("is not reachable by a non-owner", async () => {
    await say("/model openai-compat", "222");
    expect(sent).toHaveLength(0);
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });
});
