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
  "GROQ_API_KEY",
] as const;

/** Same shape, and same reason, as the Telegram twin's. */
type ConfigOverrides = {
  activeTextProvider?: string;
  runMode?: Record<string, unknown>;
  managedModelId?: string;
  /** Same field, and same reason, as the Telegram twin's. */
  extraProviders?: Array<Record<string, unknown>>;
};

function writeLlmConfig(stateDir: string, over: ConfigOverrides = {}): void {
  writeUserConfigFileSync(getUserConfigPath(stateDir), {
    ...USER_CONFIG_DEFAULTS,
    localModels: {
      ...USER_CONFIG_DEFAULTS.localModels,
      managed: {
        ...USER_CONFIG_DEFAULTS.localModels.managed,
        modelId: over.managedModelId ?? null,
      },
    },
    llm: {
      activeTextProvider: over.activeTextProvider ?? "local-llama",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto",
      ...(over.runMode ? { runMode: over.runMode } : {}),
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
        // A known-service preset: same kind as the entry above, told
        // apart only by declaring its own `apiKeyEnvVar`.
        {
          id: "groq",
          kind: "openai-compatible",
          baseUrl: "https://api.groq.com/openai/v1",
          defaultChatModel: "llama-3.3-70b",
          apiKeyEnvVar: "GROQ_API_KEY",
        },
        // The one cloud entry with no model of its own, for the
        // clear-the-pin rollback branch.
        { id: "aimlapi", kind: "aimlapi" },
        ...(over.extraProviders ?? []),
      ],
    },
  });
  resetConfigCache();
}

/** Every configured id, in fixture order, for the "Configured:" lines. */
const ALL_IDS =
  "`local-llama`, `openrouter`, `openai-compat`, `groq`, `aimlapi`";

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
    expect(report).toContain("Run mode: Local — active provider local-llama");
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
    expect(sent[0]).toContain(`Configured: ${ALL_IDS}.`);
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
      "groq",
      "aimlapi",
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
    process.env.AIMLAPI_API_KEY = "k";
    fake.failures.reload = new Error("nope");
    // `aimlapi` is the fixture's one cloud entry with no
    // `defaultChatModel`, so this is the *unset* rollback branch —
    // `restoreProviderDefaultChatModelInConfig(id, undefined)`.
    await say("/model aimlapi some-model");
    expect(sent[0]).toBe("Could not switch to `aimlapi`: nope");
    // The config parser always materialises the key, so assert the
    // value: the rollback has to leave it unset, not set to the id the
    // reload refused.
    expect(
      getConfig().llm?.providers.find((p) => p.id === "aimlapi")
        ?.defaultChatModel,
    ).toBeUndefined();
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("still answers when the session store cannot save the stamp", async () => {
    fake.failures.save = new Error("ENOSPC");
    await say("/model openai-compat");
    expect(sent).toEqual([
      "Now on `openai-compat` · `gpt-x`. Takes effect on the next message.",
    ]);
    expect(getConfig().llm?.activeTextProvider).toBe("openai-compat");
  });

  it("accepts the one-token form and splits at the first slash", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    await say("/model openrouter/vendor/model-9");
    expect(
      getConfig().llm?.providers.find((p) => p.id === "openrouter")
        ?.defaultChatModel,
    ).toBe("vendor/model-9");
  });

  it("refuses to pin a model on a local llama-server provider", async () => {
    // See the Telegram twin: the llama-server factory never reads
    // `entry.defaultChatModel`, but `resolveActiveModelName()` reads it
    // first, so the pin renames the model everywhere and changes
    // nothing that runs.
    writeLlmConfig(stateDir, { managedModelId: "qwen-3.8-27b" });
    await say("/model local-llama gpt-4-turbo");
    expect(sent[0]).toContain("nothing reads a model id off its config entry");
    expect(sent[0]).toContain("Local Models tab");
    expect(
      getConfig().llm?.providers.find((p) => p.id === "local-llama")
        ?.defaultChatModel,
    ).toBeUndefined();
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
    expect(fake.reloaded).toEqual([]);
    await say("/model");
    expect(sent[1]).toContain("Model: `local-llama` · `qwen-3.8-27b`");
  });

  it("reports the managed local model, not a placeholder", async () => {
    writeLlmConfig(stateDir, { managedModelId: "qwen-3.8-27b" });
    await say("/model");
    expect(sent[0]).toContain("Model: `local-llama` · `qwen-3.8-27b`");
    expect(sent[0]).toContain("• `local-llama` · `qwen-3.8-27b` (active)");
  });

  it("refuses a preset provider whose declared env var is unset", async () => {
    expect(process.env.GROQ_API_KEY).toBeUndefined();
    await say("/model groq");
    expect(sent[0]).toContain(
      "has no API key configured (`GROQ_API_KEY` is unset)",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
    await say("/model");
    expect(sent[1]).toContain(
      "• `groq` · `llama-3.3-70b` — no API key (GROQ_API_KEY is unset)",
    );
    // The keyless LM Studio-shaped entry must stay usable.
    expect(sent[1]).toContain("• `openai-compat` · `gpt-x`\n");
  });

  it("accepts a preset provider once its declared env var is set", async () => {
    process.env.GROQ_API_KEY = "gsk-x";
    await say("/model groq");
    expect(sent[0]).toBe(
      "Now on `groq` · `llama-3.3-70b`. Takes effect on the next message.",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("groq");
  });

  it("reports the run mode, including a fusion deployment", async () => {
    writeLlmConfig(stateDir, {
      activeTextProvider: "openrouter",
      runMode: {
        mode: "fusion",
        fusion: {
          orchestratorProvider: "openrouter",
          workerProvider: "local-llama",
        },
      },
      managedModelId: "qwen-3.8-27b",
    });
    await say("/model");
    expect(sent[0]).toContain(
      "Run mode: Fusion — orchestrator openrouter (openrouter/auto), 2 workers on local-llama (qwen-3.8-27b)",
    );
  });

  it("says so when a switch drops the deployment out of fusion", async () => {
    writeLlmConfig(stateDir, {
      activeTextProvider: "openrouter",
      runMode: {
        mode: "fusion",
        fusion: {
          orchestratorProvider: "openrouter",
          workerProvider: "local-llama",
        },
      },
      managedModelId: "qwen-3.8-27b",
    });
    await say("/model local-llama");
    expect(sent[0]).toBe(
      "Now on `local-llama` · `qwen-3.8-27b`. Takes effect on the next message.\n\n" +
        "Run mode: Fusion → Local. `fusion.delegate` and its guidance are gone " +
        "from every session until `openrouter` is active again — " +
        "`/model openrouter` restores it.",
    );
    await say("/model");
    expect(sent[1]).toContain("stored fusion, effective local");
  });

  it("says so when a switch puts the deployment back into fusion", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    writeLlmConfig(stateDir, {
      activeTextProvider: "local-llama",
      runMode: {
        mode: "fusion",
        fusion: {
          orchestratorProvider: "openrouter",
          workerProvider: "local-llama",
        },
      },
    });
    await say("/model openrouter");
    expect(sent[0]).toContain("Run mode: Local → Fusion.");
    expect(sent[0]).toContain("2 workers on `local-llama`");
  });

  it("stays quiet about an ordinary Local → Cloud switch", async () => {
    await say("/model openai-compat");
    expect(sent[0]).toBe(
      "Now on `openai-compat` · `gpt-x`. Takes effect on the next message.",
    );
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

  /** Same path, and same reason, as the Telegram twin's. */
  it("answers instead of rejecting when the config no longer parses", async () => {
    writeLlmConfig(stateDir, { activeTextProvider: "ghost" });
    await say("/model");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Could not run /model:");
    expect(sent[0]).toContain('unknown provider id "ghost"');
  });

  it("reports the managed local model only for the daemon that serves it", async () => {
    writeLlmConfig(stateDir, {
      managedModelId: "qwen-3.8-27b",
      extraProviders: [
        { id: "remote-box", kind: "llama-server", url: "http://10.0.0.9:8080" },
      ],
    });
    await say("/model");
    expect(sent[0]).toContain("• `local-llama` · `qwen-3.8-27b` (active)");
    expect(sent[0]).toContain("• `remote-box` · `provider default`");
  });

  it("caps the provider list so the report stays one message", async () => {
    writeLlmConfig(stateDir, {
      // `PROVIDER_ID_RE` caps an id at 32 kebab-case characters, so
      // the bulk here is the model names, which the schema does not
      // bound at all.
      extraProviders: Array.from({ length: 60 }, (_, i) => ({
        id: `compat-provider-${i}`,
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${1300 + i}/v1`,
        defaultChatModel: `vendor/really-long-model-identifier-v${i}-instruct`,
      })),
    });
    await say("/model");
    expect(sent).toHaveLength(1);
    const [report = ""] = sent;
    // `DiscordApi.sendMessage` chunks silently at
    // `DISCORD_MESSAGE_LIMIT`; the stub above does not, so the length
    // is asserted directly.
    expect(report.length).toBeLessThanOrEqual(2000);
    expect(report).toContain("more not shown");
    expect(report).toContain("Model: `local-llama` · `provider default`");
    expect(report).toContain("`/model <provider>` switches provider");
  });

  it("clips a model id long enough to fill the message on its own", async () => {
    // A provider id cannot get here — `PROVIDER_ID_RE` caps it at 32
    // characters — but a model id is any non-empty string.
    const long = `vendor/${"m".repeat(400)}`;
    writeLlmConfig(stateDir, {
      extraProviders: [
        {
          id: "long-model-compat",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:1299/v1",
          defaultChatModel: long,
        },
      ],
    });
    await say("/model");
    expect(sent[0]).not.toContain(long);
    expect(sent[0]).toContain("vendor/mmm");
    expect(sent[0]).toContain("…");
    expect(sent[0]?.length).toBeLessThanOrEqual(2000);
  });

  it("keeps the active provider in the list even when the cap drops the rest", async () => {
    writeLlmConfig(stateDir, {
      activeTextProvider: "compat-provider-59",
      extraProviders: Array.from({ length: 60 }, (_, i) => ({
        id: `compat-provider-${i}`,
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${1300 + i}/v1`,
        defaultChatModel: `vendor/really-long-model-identifier-v${i}-instruct`,
      })),
    });
    await say("/model");
    const [report = ""] = sent;
    expect(report.length).toBeLessThanOrEqual(2000);
    expect(report).toContain(
      "• `compat-provider-59` · `vendor/really-long-model-identifier-v59-instruct` (active)",
    );
    expect(report).toContain("more not shown");
  });

  /**
   * The three refusals and the one confirmation below all interpolate a
   * name the config schema does not bound, and all four are reachable
   * with a single chat message: Discord accepts 2000 characters inbound
   * and Telegram 4096, so "the operator just typed it" is the *likeliest*
   * source of a pathological id, not the least likely. The report's cap
   * (above) never sees these paths.
   */
  it("clips the model id in the switch confirmation", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    // 2000 characters in total — exactly what Discord accepts inbound,
    // and well inside Telegram's own 4096.
    const long = `vendor/${"m".repeat(1975)}`;
    await say(`/model openrouter ${long}`);
    expect(sent).toHaveLength(1);
    // The stub above does not chunk the way `DiscordApi.sendMessage`
    // does, so the length is asserted directly.
    expect(sent[0]?.length).toBeLessThanOrEqual(2000);
    expect(sent[0]).not.toContain(long);
    expect(sent[0]).toContain("…");
    // Clipping is a display concern only: the pin the TUI reads back is
    // the id that was typed, whole.
    expect(
      getConfig().llm?.providers.find((p) => p.id === "openrouter")
        ?.defaultChatModel,
    ).toBe(long);
  });

  it("clips the model id in the llama-server refusal", async () => {
    const long = `vendor/${"m".repeat(1974)}`;
    await say(`/model local-llama ${long}`);
    expect(sent).toHaveLength(1);
    // The stub above does not chunk the way `DiscordApi.sendMessage`
    // does, so the length is asserted directly.
    expect(sent[0]?.length).toBeLessThanOrEqual(2000);
    expect(sent[0]).not.toContain(long);
    expect(sent[0]).toContain("…");
    // Still a refusal, not a pin.
    expect(
      getConfig().llm?.providers.find((p) => p.id === "local-llama")
        ?.defaultChatModel,
    ).toBeUndefined();
  });

  it("clips a declared env var in the no-key refusal", async () => {
    // `apiKeyEnvVar` is `parseOptionalString`, so it is any non-empty
    // string — the report already clips it, and this refusal is the
    // other place it is printed.
    const long = `LONG_${"E".repeat(500)}`;
    writeLlmConfig(stateDir, {
      extraProviders: [
        {
          id: "long-env",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:1298/v1",
          defaultChatModel: "gpt-x",
          apiKeyEnvVar: long,
        },
      ],
    });
    await say("/model long-env");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("has no API key configured");
    expect(sent[0]).not.toContain(long);
    expect(sent[0]).toContain("…");
    expect(sent[0]?.length).toBeLessThanOrEqual(2000);
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("names every candidate an ambiguous prefix matches", async () => {
    // This is the one message whose whole job is "say which one", so it
    // is fitted to the message limit rather than to an entry count: a
    // candidate that is hidden cannot be picked, and a chat offers no
    // way to page through the rest.
    writeLlmConfig(stateDir, {
      extraProviders: Array.from({ length: 60 }, (_, i) => ({
        id: `compat-provider-${i}`,
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${1300 + i}/v1`,
        defaultChatModel: `vendor/really-long-model-identifier-v${i}-instruct`,
      })),
    });
    await say("/model compat");
    expect(sent).toHaveLength(1);
    const [msg = ""] = sent;
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg).toContain("`compat-provider-0`");
    // The sixtieth, not a count: all of them fit, so all of them print.
    expect(msg).toContain("`compat-provider-59`");
    expect(msg).not.toMatch(/and \d+ more/);
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  it("counts ambiguous candidates only past the limit, and says how to narrow", async () => {
    // 120 entries at the longest id `PROVIDER_ID_RE` allows (32
    // characters) — more than one message can hold however it is
    // fitted, which is the only case where hiding one is unavoidable.
    writeLlmConfig(stateDir, {
      extraProviders: Array.from({ length: 120 }, (_, i) => ({
        id: `zz-aaaaaaaaaaaaaaaaaaaaaaaaa-${String(i).padStart(3, "0")}`,
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${1300 + i}/v1`,
        defaultChatModel: "gpt-x",
      })),
    });
    await say("/model zz");
    expect(sent).toHaveLength(1);
    const [msg = ""] = sent;
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg).toMatch(/and \d+ more/);
    // A count alone would be unactionable; this is the one thing the
    // operator can do about it from a chat.
    expect(msg).toContain("type more of the id to narrow the list");
  });
});
