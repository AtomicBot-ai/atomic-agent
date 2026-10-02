import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "./bootstrap.js";
import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { UserConfigFile } from "../config/index.js";
import { FakeBrowserBackend } from "../http/test-harness.js";
import { resetModelVisionRejections } from "../llm/provider/model-vision-rejections.js";

/**
 * Vision belongs to the MODEL serving the step, not to the provider.
 * The hand-QA case: a session on local qwen-3.5-4b (projector loaded)
 * switched to aimlapi's `deepseek/deepseek-v4-flash`, a text-only
 * model. The tool stayed offered, the model called it four times, got
 * `openai provider 400: … Validation failed` four times, then tried
 * `magick`. Now the catalogue's "text-only" removes the tool and
 * refuses a direct call without a request; a model nobody describes is
 * offered until the service rejects an image, and refused after that.
 *
 * Booted for real and asserted on the wire, like
 * `vision-follows-route.test.ts`.
 */

const LOCAL = "127.0.0.1:8080";
const AIML = "aiml.invalid";
const CUSTOM = "custom.invalid";

const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash";
const VISION_MODEL = "anthropic/claude-opus-5";

const aimlapi = (model: string, extra: Record<string, unknown> = {}) => ({
  id: "aimlapi",
  kind: "aimlapi" as const,
  baseUrl: `https://${AIML}`,
  defaultChatModel: model,
  apiKey: "sk-test",
  ...extra,
});
const CUSTOM_PROVIDER = {
  id: "custom",
  kind: "openai-compatible" as const,
  baseUrl: `https://${CUSTOM}`,
  defaultChatModel: "house-model-7",
  apiKey: "sk-test",
};
const LOCAL_PROVIDER = {
  id: "local-llama",
  kind: "llama-server" as const,
  url: `http://${LOCAL}`,
};
const LOCAL_EMBED_PROVIDER = {
  id: "local-llama-embed",
  kind: "llama-server" as const,
  url: "http://127.0.0.1:19092",
};

const llm = (
  activeTextProvider: string,
  cloud: Record<string, unknown>[] = [aimlapi(TEXT_ONLY_MODEL)],
) => ({
  activeTextProvider,
  activeEmbeddingProvider: "local-llama-embed",
  providers: [...cloud, LOCAL_PROVIDER, LOCAL_EMBED_PROVIDER],
  toolTransport: "auto" as const,
});

function chatAnswer(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface Traffic {
  visionCalls: string[];
  /** Cloud hosts answer chat completions with this, when set. */
  cloudReply: Response | (() => Response) | null;
}

function installFetch(): Traffic {
  const traffic: Traffic = { visionCalls: [], cloudReply: null };
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/chat/completions")) {
      traffic.visionCalls.push(url);
      if (!url.includes(LOCAL) && traffic.cloudReply) {
        const reply = traffic.cloudReply;
        return typeof reply === "function" ? reply() : reply;
      }
      return chatAnswer(url.includes(LOCAL) ? "local sees" : "cloud sees");
    }
    if (url.includes(LOCAL) && url.includes("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return new Response("{}", {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return traffic;
}

/** aimlapi's answer to an image sent to a text-only model. */
const validationFailed = (): Response =>
  new Response(JSON.stringify({ message: "Validation failed" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("vision.describe follows the model, not the provider", () => {
  let stateDir: string;
  let workingDir: string;
  let traffic: Traffic;

  const writeConfig = (over: Partial<UserConfigFile>): void => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      analytics: { enabled: false },
      // Trust the operator on the local link, so the test does not
      // depend on a `/props` probe landing before the call.
      vision: { ...USER_CONFIG_DEFAULTS.vision, autoDetect: false },
      ...over,
    });
    resetConfigCache();
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-vision-model-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-vision-model-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    writeFileSync(join(workingDir, "shot.png"), PNG);
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    resetModelVisionRejections();
    traffic = installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
    resetModelVisionRejections();
  });

  const boot = () =>
    createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: new FakeBrowserBackend(),
        disableStreaming: true,
      },
    });

  type Runtime = Awaited<ReturnType<typeof boot>>;

  const describeShot = (runtime: Runtime) =>
    runtime.toolRegistry.invoke(
      "vision.describe",
      { path: "shot.png", prompt: "what is this?" },
      {
        workingDir,
        sessionId: "s-vision",
        stepIndex: 1,
        signal: new AbortController().signal,
      },
    );

  const offersVision = (runtime: Runtime): boolean =>
    runtime.toolDescriptors.some((d) => d.name === "vision.describe");

  it("a text-only cloud model is not offered vision, and a direct call is refused by model and provider with no request", async () => {
    writeConfig({ llm: llm("aimlapi") });
    const runtime = await boot();
    try {
      expect(offersVision(runtime)).toBe(false);

      const refused = await describeShot(runtime);
      expect(refused.status).toBe("error");
      expect(refused.summary).toMatch(
        /deepseek\/deepseek-v4-flash on aimlapi cannot read images \(the model catalogue lists it as text-only\) — switch to a vision model \(/,
      );
      // Somewhere to go: the first vision rows of the same provider's
      // curated catalogue order.
      expect(refused.summary).toContain(
        "(openai/gpt-5.5-2026-04-23, openai/gpt-5.4-2026-03-05, openai/gpt-5-mini-2025-08-07 via /model, or a local model with a vision projector)",
      );
      expect(refused.summary).toMatch(/do not call it again/);
      expect(refused.details).toMatchObject({
        retryable: false,
        reason: "model-cannot-see",
        provider: "aimlapi",
        model: TEXT_ONLY_MODEL,
        visionSource: "catalog",
      });
      expect(traffic.visionCalls).toHaveLength(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("local (vision) -> cloud text-only -> local: removed and refused on the cloud model, restored on the way back", async () => {
    writeConfig({ llm: llm("local-llama") });
    const runtime = await boot();
    const switchTo = async (id: string): Promise<void> => {
      await runtime.providerRegistry.setActive(id);
      writeConfig({ llm: llm(id) });
    };
    try {
      expect(offersVision(runtime)).toBe(true);
      expect((await describeShot(runtime)).summary).toContain("local sees");
      expect(traffic.visionCalls).toHaveLength(1);

      await switchTo("aimlapi");
      expect(offersVision(runtime)).toBe(false);
      const refused = await describeShot(runtime);
      expect(refused.status).toBe("error");
      expect(refused.summary).toMatch(/deepseek\/deepseek-v4-flash on aimlapi cannot read images/);
      expect(traffic.visionCalls).toHaveLength(1);

      await switchTo("local-llama");
      expect(offersVision(runtime)).toBe(true);
      expect((await describeShot(runtime)).summary).toContain("local sees");
      expect(traffic.visionCalls).toHaveLength(2);
      expect(traffic.visionCalls.every((url) => url.includes(LOCAL))).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("a vision model on the same provider is offered and sent the image", async () => {
    writeConfig({ llm: llm("aimlapi", [aimlapi(VISION_MODEL)]) });
    const runtime = await boot();
    try {
      expect(offersVision(runtime)).toBe(true);
      const result = await describeShot(runtime);
      expect(result.status).toBe("ok");
      expect(traffic.visionCalls).toHaveLength(1);
      expect(traffic.visionCalls[0]).toContain(AIML);
    } finally {
      await runtime.shutdown();
    }
  });

  it("an undescribed cloud model is offered until the service rejects an image, then refused with no request", async () => {
    writeConfig({ llm: llm("custom", [CUSTOM_PROVIDER]) });
    const runtime = await boot();
    try {
      expect(offersVision(runtime)).toBe(true);
      traffic.cloudReply = validationFailed;

      const first = await describeShot(runtime);
      expect(first.status).toBe("error");
      expect(first.summary).toMatch(
        /house-model-7 on custom cannot read images \(house-model-7 on custom rejected the image \(openai provider 400: .*Validation failed/,
      );
      expect(first.details).toMatchObject({
        retryable: false,
        reason: "model-cannot-see",
        visionSource: "rejected-images",
      });
      expect(traffic.visionCalls).toHaveLength(1);

      // Marked: out of the prompt, and the next call never leaves.
      expect(offersVision(runtime)).toBe(false);
      const second = await describeShot(runtime);
      expect(second.status).toBe("error");
      expect(second.summary).toMatch(
        /house-model-7 on custom cannot read images \(the service rejected an image sent to it\)/,
      );
      expect(traffic.visionCalls).toHaveLength(1);

      // A config write rebuilds the provider; the verdict survives it.
      await runtime.reloadLlmProvider("custom");
      expect(offersVision(runtime)).toBe(false);
      await describeShot(runtime);
      expect(traffic.visionCalls).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("a failure that is not about images leaves an undescribed model offered", async () => {
    writeConfig({ llm: llm("custom", [CUSTOM_PROVIDER]) });
    const runtime = await boot();
    try {
      traffic.cloudReply = () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      const result = await describeShot(runtime);
      expect(result.status).toBe("error");
      expect(result.summary).toMatch(/vision call failed: .*401/);
      expect(offersVision(runtime)).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("explicit config wins over the catalogue, per model and per provider", async () => {
    // The catalogue says text-only; the operator's userModels row says
    // this model can see.
    writeConfig({
      llm: llm("aimlapi", [
        aimlapi(TEXT_ONLY_MODEL, {
          userModels: [{ id: TEXT_ONLY_MODEL, kind: "chat", supportsVision: true }],
        }),
      ]),
    });
    let runtime = await boot();
    try {
      expect(offersVision(runtime)).toBe(true);
      expect((await describeShot(runtime)).status).toBe("ok");
      expect(traffic.visionCalls).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }

    // The catalogue says the model sees; the operator's provider-wide
    // flag says it does not.
    writeConfig({
      llm: llm("aimlapi", [aimlapi(VISION_MODEL, { supportsVision: false })]),
    });
    runtime = await boot();
    try {
      expect(offersVision(runtime)).toBe(false);
      const refused = await describeShot(runtime);
      expect(refused.summary).toMatch(
        /anthropic\/claude-opus-5 on aimlapi cannot read images \(its llm\.providers\[\] entry sets supportsVision: false\)/,
      );
      expect(traffic.visionCalls).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });
});
