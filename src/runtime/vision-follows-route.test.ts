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

/**
 * `vision.describe` must follow the live route. The tool used to hold
 * the provider that was active at boot: a session started on a
 * text-only cloud model and switched to a local vision model kept
 * sending images to the cloud and got its 400 back until a restart.
 *
 * Booted for real (`createAgentRuntime`), switched the way the LLM tab
 * switches (registry first, then config), and asserted on the wire:
 * which host the image went to, and that nothing went anywhere when the
 * current provider cannot see.
 */

const LOCAL = "127.0.0.1:8080";
const CLOUD = "cloud.invalid";

const CLOUD_PROVIDER = {
  id: "cloudy",
  kind: "openai-compatible" as const,
  baseUrl: `https://${CLOUD}`,
  defaultChatModel: "cloudy-1",
  apiKey: "sk-test",
};
const LOCAL_PROVIDER = {
  id: "local-llama",
  kind: "llama-server" as const,
  url: `http://${LOCAL}`,
};
const CLI_PROVIDER = {
  id: "claude-cli",
  kind: "subscription-cli" as const,
  defaultChatModel: "opus",
  subscriptionCli: { cli: "claude" as const },
};
const LOCAL_EMBED_PROVIDER = {
  id: "local-llama-embed",
  kind: "llama-server" as const,
  url: "http://127.0.0.1:19092",
};

const llmWithActive = (activeTextProvider: string) => ({
  activeTextProvider,
  activeEmbeddingProvider: "local-llama-embed",
  providers: [CLOUD_PROVIDER, LOCAL_PROVIDER, CLI_PROVIDER, LOCAL_EMBED_PROVIDER],
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

/** Every chat-completions POST, by host. */
function installFetch(): { visionCalls: string[] } {
  const visionCalls: string[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/chat/completions")) {
      visionCalls.push(url);
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
  return { visionCalls };
}

/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("vision.describe follows the live route", () => {
  let stateDir: string;
  let workingDir: string;
  let traffic: { visionCalls: string[] };

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
    stateDir = mkdtempSync(join(tmpdir(), "atomic-vision-route-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-vision-route-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    writeFileSync(join(workingDir, "shot.png"), PNG);
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    traffic = installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
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

  /** Exactly what the LLM tab does: registry first, then config. */
  const switchTo = async (runtime: Runtime, id: string): Promise<void> => {
    await runtime.providerRegistry.setActive(id);
    writeConfig({ llm: llmWithActive(id) });
  };

  const describeShot = (runtime: Runtime, providerId?: string) =>
    runtime.toolRegistry.invoke(
      "vision.describe",
      { path: "shot.png", prompt: "what is this?" },
      {
        workingDir,
        sessionId: "s-vision",
        stepIndex: 1,
        signal: new AbortController().signal,
        ...(providerId !== undefined ? { providerId } : {}),
      },
    );

  const offersVision = (runtime: Runtime): boolean =>
    runtime.toolDescriptors.some((d) => d.name === "vision.describe");

  it("a cloud->local switch mid-session sends the next image to the local model", async () => {
    writeConfig({ llm: llmWithActive("cloudy") });
    const runtime = await boot();
    try {
      const before = await describeShot(runtime);
      expect(before.status).toBe("ok");
      expect(traffic.visionCalls).toHaveLength(1);
      expect(traffic.visionCalls[0]).toContain(CLOUD);

      await switchTo(runtime, "local-llama");
      traffic.visionCalls.length = 0;

      const after = await describeShot(runtime);
      expect(after.status).toBe("ok");
      expect(after.summary).toContain("local sees");
      expect(traffic.visionCalls).toHaveLength(1);
      expect(traffic.visionCalls[0]).toContain(LOCAL);
    } finally {
      await runtime.shutdown();
    }
  });

  it("a step pinned to the fusion worker leg sees through the worker's provider", async () => {
    writeConfig({ llm: llmWithActive("cloudy") });
    const runtime = await boot();
    try {
      const result = await describeShot(runtime, "local-llama");
      expect(result.status).toBe("ok");
      expect(traffic.visionCalls).toHaveLength(1);
      expect(traffic.visionCalls[0]).toContain(LOCAL);
    } finally {
      await runtime.shutdown();
    }
  });

  it("a route that cannot see is refused by name, with no call made, and the prompt follows", async () => {
    writeConfig({ llm: llmWithActive("cloudy") });
    const runtime = await boot();
    try {
      expect(offersVision(runtime)).toBe(true);

      await switchTo(runtime, "claude-cli");
      expect(offersVision(runtime)).toBe(false);
      const refused = await describeShot(runtime);
      expect(refused.status).toBe("error");
      expect(refused.summary).toMatch(
        /vision is not available on the active provider \(claude-cli: config-disabled\)/,
      );
      expect(traffic.visionCalls).toHaveLength(0);

      await switchTo(runtime, "local-llama");
      expect(offersVision(runtime)).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("a pin the registry does not hold is refused, never re-routed to the active provider", async () => {
    writeConfig({ llm: llmWithActive("cloudy") });
    const runtime = await boot();
    try {
      const result = await describeShot(runtime, "gone-worker");
      expect(result.status).toBe("error");
      expect(result.summary).toMatch(/"gone-worker" is not configured/);
      expect(traffic.visionCalls).toHaveLength(0);
    } finally {
      await runtime.shutdown();
    }
  });
});
