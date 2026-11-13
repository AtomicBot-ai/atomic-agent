import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AtomicAgentConfig } from "../../../config/index.js";
import { resetConfigCache } from "../../../config/index.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../../../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../../../config/config-schema.js";
import { loadConfig } from "../../../config/load-config.js";
import { resetKeyPoolState } from "../../fallback/key-pool.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../model-profile.js";
import { registerBuiltInProviderKinds } from "./register-built-in-providers.js";
import {
  getProviderFactory,
  type LlmProviderConfigEntry,
} from "./provider-types.js";

const PREFERENCES = { order: ["z-ai"], allow_fallbacks: false };

/**
 * Builds the provider exactly as config does — through the registered
 * factory — and returns the chat body its first completion sent.
 */
async function firstBody(
  entry: LlmProviderConfigEntry,
): Promise<Record<string, unknown>> {
  registerBuiltInProviderKinds();
  const factory = getProviderFactory(entry.kind);
  if (!factory) throw new Error(`${entry.kind} is not registered`);
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  const provider = await factory({
    config: {} as AtomicAgentConfig,
    entry,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
  });
  await provider.complete({ prompt: "hi" });
  const body = bodies[0];
  if (!body) throw new Error(`${entry.kind} sent no request`);
  return body;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("providerPreferences through the built-in factories", () => {
  it("the openrouter factory forwards them as `provider`", async () => {
    const body = await firstBody({
      id: "openrouter",
      kind: "openrouter",
      apiKey: "test-key",
      defaultChatModel: "z-ai/glm-5.3-flash",
      providerPreferences: PREFERENCES,
    });
    expect(body.provider).toEqual(PREFERENCES);
  });

  // `provider` is OpenRouter's field. Sent to any other OpenAI-shaped
  // service it is at best ignored and at worst a 400, so the other
  // kinds must keep their bodies untouched even with the key present.
  it.each(["openai-compatible", "qwen-openai-compatible", "aimlapi", "gemini"])(
    "%s does not send them",
    async (kind) => {
      const body = await firstBody({
        id: kind,
        kind,
        apiKey: "test-key",
        baseUrl: "https://example.invalid",
        defaultChatModel: "some-model",
        providerPreferences: PREFERENCES,
      });
      expect(body).not.toHaveProperty("provider");
    },
  );
});

describe("userModels[] wire options through the built-in factories", () => {
  // `reasoningFormat` and `params` on the entry's row for the model it
  // serves reach the provider; a row for another model does not.
  it.each(["openai-compatible", "qwen-openai-compatible", "openrouter", "aimlapi", "gemini"])(
    "%s applies the served model's params and reasoning format",
    async (kind) => {
      registerBuiltInProviderKinds();
      const factory = getProviderFactory(kind);
      if (!factory) throw new Error(`${kind} is not registered`);
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(
            JSON.stringify({
              choices: [
                { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }),
      );
      const provider = await factory({
        config: {} as AtomicAgentConfig,
        entry: {
          id: kind,
          kind,
          apiKey: "test-key",
          baseUrl: "https://example.invalid",
          defaultChatModel: "served-model",
          userModels: [
            {
              id: "other-model",
              kind: "chat",
              reasoningFormat: "delta_thinking",
              params: { top_p: 0.1 },
            },
            {
              id: "served-model",
              kind: "chat",
              reasoningFormat: "delta_reasoning_content",
              params: { top_p: 0.9, presence_penalty: 0.5 },
            },
          ],
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      });
      expect(provider.capabilities.reasoningFormat).toBe("delta_reasoning_content");
      await provider.complete({ prompt: "hi" });
      expect(bodies[0]).toMatchObject({ top_p: 0.9, presence_penalty: 0.5 });
    },
  );

  it("defaults to `auto` reasoning and no extra parameters without a row", async () => {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory("openai-compatible");
    if (!factory) throw new Error("openai-compatible is not registered");
    const provider = await factory({
      config: {} as AtomicAgentConfig,
      entry: {
        id: "plain",
        kind: "openai-compatible",
        apiKey: "test-key",
        baseUrl: "https://example.invalid",
        defaultChatModel: "some-model",
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    expect(provider.capabilities.reasoningFormat).toBe("auto");
  });
});

describe("llm.openrouter.preferCacheRoutes through the openrouter factory", () => {
  async function openRouterBody(
    config: Partial<AtomicAgentConfig>,
    entry: Partial<LlmProviderConfigEntry>,
  ): Promise<Record<string, unknown>> {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory("openrouter");
    if (!factory) throw new Error("openrouter is not registered");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const provider = await factory({
      config: config as AtomicAgentConfig,
      entry: {
        id: "openrouter",
        kind: "openrouter",
        apiKey: "test-key",
        defaultChatModel: "google/gemini-3.8-flash",
        ...entry,
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    await provider.complete({ prompt: "hi" });
    return bodies[0]!;
  }

  it("is on when the file says nothing", async () => {
    const body = await openRouterBody({}, {});
    expect(body.provider).toEqual({
      order: ["Google AI Studio", "Google"],
      allow_fallbacks: true,
    });
  });

  it("is off when the file says so, and yields to the entry's own preferences", async () => {
    const off = await openRouterBody(
      { llm: { openrouter: { preferCacheRoutes: false } } } as Partial<AtomicAgentConfig>,
      {},
    );
    expect(off).not.toHaveProperty("provider");
    const own = await openRouterBody({}, { providerPreferences: PREFERENCES });
    expect(own.provider).toEqual(PREFERENCES);
  });
});

describe("the vision request budget through the llama-server factory", () => {
  /**
   * The budget the factory hands the provider is private, so it is
   * measured instead of read: this server answers with headers and then
   * stalls, and only the forwarded deadline can end the call. A budget
   * that was not forwarded falls back to the provider's own hardcoded
   * 120 s and the race below reports `hung`.
   */
  async function visionOutcome(
    entry: Partial<LlmProviderConfigEntry>,
  ): Promise<string> {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory("llama-server");
    if (!factory) throw new Error("llama-server is not registered");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal?.aborted) throw init.signal.reason;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"choices":'));
              init?.signal?.addEventListener("abort", () =>
                stream.error(init.signal?.reason ?? new Error("aborted")),
              );
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const provider = await factory({
      config: {} as AtomicAgentConfig,
      entry: {
        id: "local-llama",
        kind: "llama-server",
        url: "http://test-llama:9999",
        ...entry,
      },
      llamaClient: {} as never,
      getProfile: () => ({
        ...PLAIN_INSTRUCT_PROFILE,
        vision: { supported: true, source: "has_multimodal" },
      }),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      provider
        .describeImage({
          prompt: "x",
          images: [
            {
              id: 1,
              bytes: new Uint8Array([0xff, 0xd8, 0xff]),
              mimeType: "image/jpeg",
            },
          ],
        })
        .then(
          () => "resolved",
          () => "rejected",
        ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("hung"), 1_000);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return outcome;
  }

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS;
    resetConfigCache();
  });

  it("follows the operator's localModels.requestTimeoutMs", async () => {
    process.env.ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS = "20";
    resetConfigCache();
    expect(await visionOutcome({})).toBe("rejected");
  });

  it("lets the entry's own requestTimeoutMs win", async () => {
    process.env.ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS = "600000";
    resetConfigCache();
    expect(await visionOutcome({ requestTimeoutMs: 20 })).toBe("rejected");
  });
});

describe("extra keys by env var name (ATO-471)", () => {
  const silentLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;

  const chatOk = () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  /** Records the Authorization each request carried; answers per key. */
  function stubFetchByKey(answers: Record<string, () => Response>): string[] {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers.authorization ?? headers.Authorization ?? "";
        seen.push(auth);
        const answer = answers[auth.replace(/^Bearer /, "")];
        return answer ? answer() : new Response("unexpected key", { status: 500 });
      }),
    );
    return seen;
  }

  async function build(entry: LlmProviderConfigEntry) {
    registerBuiltInProviderKinds();
    const factory = getProviderFactory(entry.kind);
    if (!factory) throw new Error(`${entry.kind} is not registered`);
    return factory({ config: {} as AtomicAgentConfig, entry, logger: silentLogger });
  }

  const created: string[] = [];
  const setEnv = (name: string, value: string) => {
    created.push(name);
    process.env[name] = value;
  };

  afterEach(() => {
    for (const name of created.splice(0)) delete process.env[name];
    resetKeyPoolState();
  });

  it("with apiKey blank and one extra key set, requests carry that key", async () => {
    setEnv("ATO471_ONLY_KEY", "only-extra-key");
    const seen = stubFetchByKey({ "only-extra-key": chatOk });
    const provider = await build({
      id: "groq",
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      defaultChatModel: "llama-3.3-70b-versatile",
      extraApiKeyEnvVars: ["ATO471_ONLY_KEY"],
    });
    await provider.complete({ prompt: "hi" });
    expect(seen).toEqual(["Bearer only-extra-key"]);
  });

  it("reads the extra key from <stateDir>/.env: the pool has both keys and config.json holds no key", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "atomic-471-"));
    const previousStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    created.push("ATO471_K1", "K2");
    try {
      writeFileSync(join(stateDir, ".env"), "ATO471_K1=key-one\nK2=key-two\n", "utf8");
      const configPath = getUserConfigPath(stateDir);
      writeUserConfigFileSync(configPath, {
        ...USER_CONFIG_DEFAULTS,
        llm: {
          activeTextProvider: "groq",
          activeEmbeddingProvider: "local-llama",
          toolTransport: "auto",
          providers: [
            { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
            {
              id: "groq",
              kind: "openai-compatible",
              baseUrl: "https://api.groq.com/openai/v1",
              defaultChatModel: "llama-3.3-70b-versatile",
              apiKeyEnvVar: "ATO471_K1",
              extraApiKeyEnvVars: ["K2"],
            },
          ],
        },
      });
      resetConfigCache();
      const entry = loadConfig().llm?.providers.find((p) => p.id === "groq");
      if (!entry) throw new Error("groq entry missing");

      // The first key is refused; the pool moves on to K2's key.
      const seen = stubFetchByKey({
        "key-one": () => new Response("invalid api key", { status: 401 }),
        "key-two": chatOk,
      });
      const provider = await build(entry as LlmProviderConfigEntry);
      await provider.complete({ prompt: "hi" });
      expect(seen).toEqual(["Bearer key-one", "Bearer key-two"]);

      const onDisk = readFileSync(configPath, "utf8");
      expect(onDisk).toContain('"K2"');
      expect(onDisk).not.toContain("key-one");
      expect(onDisk).not.toContain("key-two");
    } finally {
      if (previousStateDir === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
      else process.env.ATOMIC_AGENT_STATE_DIR = previousStateDir;
      resetConfigCache();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
