import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import { fakeSession } from "../test-fixtures.js";
import { ProvidersOrchestrator } from "./providers-orchestrator.js";

vi.mock("../../config/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../config/index.js")>();
  return {
    ...original,
    getConfig: () => currentConfig,
  };
});

let currentConfig: AtomicAgentConfig;

function configWithNous(baseUrl: string): AtomicAgentConfig {
  return {
    llm: {
      activeTextProvider: "nous",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        {
          id: "nous",
          kind: "openai-compatible",
          baseUrl,
          apiKey: "sk-nous-test",
          model: "nous/bytedance",
          defaultChatModel: "nous/bytedance",
        },
      ],
    },
  } as AtomicAgentConfig;
}

const SESSION = fakeSession({ workingDir: "/tmp/smoke" });

function strip(value: string): string {
  return value
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\]8;;[^]*/g, "");
}

const tick = () => new Promise((r) => setTimeout(r, 25));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("full-app picker reopen (ink render, real orchestrator)", () => {
  it("/model opens, Esc closes, /model opens again", async () => {
    currentConfig = configWithNous("https://app.nous.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "alpha" }, { id: "beta" }] }),
      })),
    );

    const bus = makeTuiEventBus();
    const orchestrator = new ProvidersOrchestrator({} as AgentRuntime, bus);
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: () => {},
      onAbort: () => {},
      onQuit: () => {},
      onMessageSubmitted: () => {},
      onProvidersTabRefresh: () => orchestrator.refresh(),
      onProvidersChatModelPickerRequested: (providerId) =>
        void orchestrator.openChatModelPicker(providerId),
    };
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={callbacks} />,
    );
    await tick();

    // First /model from the chat editor.
    stdin.write("/model");
    await tick();
    stdin.write("\r");
    await tick();
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("Models — nous");

    // Esc closes the picker.
    stdin.write("");
    await tick();
    expect(strip(lastFrame() ?? "")).not.toContain("Models — nous");

    // Second /model, typed from the LLM tab.
    stdin.write("/");
    await tick();
    stdin.write("model");
    await tick();
    stdin.write("\r");
    await tick();
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("Models — nous");

    unmount();
  });
});
