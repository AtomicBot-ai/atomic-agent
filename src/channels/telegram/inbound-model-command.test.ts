/**
 * `/model` over Telegram, end to end through `handleInboundText`.
 *
 * Nothing here is mocked: the command writes the real user config in an
 * isolated `ATOMIC_AGENT_STATE_DIR`, which is the point — the whole
 * feature is "the chat writes the same state the TUI writes", so a test
 * against a stubbed config writer would prove nothing about that.
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
        { id: "openai-compat", kind: "openai-compatible", model: "gpt-x" },
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
  const runtime = {
    createSession: () => sessions[0],
    sessionStore: {
      load: (id: string) => sessions.find((s) => s.id === id) ?? null,
      save: (state: SessionState) => {
        saved.push(state);
        const at = sessions.findIndex((s) => s.id === state.id);
        if (at >= 0) sessions[at] = state;
      },
    },
    turnController: { isBusy: (id: string) => busy.has(id) },
    providerRegistry: {
      listIds: () => ["local-llama", "openrouter"],
      setActive: vi.fn(async (id: string) => {
        activated.push(id);
        return {};
      }),
    },
    reloadLlmProvider: vi.fn(async (id: string) => {
      reloaded.push(id);
    }),
    reloadLlmProviders: vi.fn(async () => {
      reloaded.push("*");
    }),
    runTurn: async () => ({ session: sessions[0], reason: "reply" as const }),
  } as unknown as AgentRuntime;
  return { runtime, busy, saved, reloaded, activated };
}

describe("/model over Telegram", () => {
  let stateDir: string;
  let dir: string;
  let pointer: TelegramSessionPointer;
  let sent: string[];
  let ctx: InboundContext;
  let session: SessionState;
  let fake: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
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
    // No API key in the environment for the openrouter entry.
    expect(report).toContain("no API key");
    // Plain text on Telegram: the id decoration must not leak backticks.
    expect(report).not.toContain("`");
  });

  it("pins a model on a provider, activates it, and stamps the session", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    try {
      await say("/model openrouter anthropic/claude-opus-4");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
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
    // The stamp is what a later session switch reads back.
    expect(readSessionLlmStamp(fake.saved.at(-1)?.metadata)).toEqual({
      providerId: "openrouter",
      chatModel: "anthropic/claude-opus-4",
    });
  });

  it("accepts the one-token form and splits at the first slash", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    try {
      await say("/model openrouter/vendor/model-9");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
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
