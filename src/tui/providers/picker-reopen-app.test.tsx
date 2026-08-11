import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import { fakeSession } from "../test-fixtures.js";
import { ProvidersOrchestrator } from "./providers-orchestrator.js";

/**
 * Full-app regression tests rendered through real Ink: real stdin
 * keystrokes, real bus, real orchestrator, real reducer. This is the
 * layer where the "/model works only once" bug lived: the LLM panel
 * seeds the editor buffer with "/" from a hotkey, and the editor's
 * private cursor used to stay at 0, turning the second "/model" into
 * "model/" which never ran. No harness below the app shell can catch
 * that class of bug.
 */

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
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\]8;;[^]*/g, "");
}

const tick = () => new Promise((r) => setTimeout(r, 25));

function makeApp() {
  const bus = makeTuiEventBus();
  const orchestrator = new ProvidersOrchestrator({} as AgentRuntime, bus);
  const onProvidersSelectChatModel = vi.fn();
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
    onProvidersTabRefresh: () => {
      orchestrator.refresh();
      void orchestrator.ensureInlineModels(null);
    },
    onProvidersSelectChatModel,
    onProvidersInlineModelsEnsureRequested: (providerId) =>
      void orchestrator.ensureInlineModels(providerId),
  };
  const rendered = render(
    <TuiApp session={SESSION} bus={bus} callbacks={callbacks} />,
  );
  return { ...rendered, onProvidersSelectChatModel };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("full-app inline model list (ink render, real orchestrator)", () => {
  it("/model focuses the filter, Esc exits, /model works again (editor cursor regression)", async () => {
    currentConfig = configWithNous("https://app-inline.nous.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ id: "qwen/qwen-3.5" }, { id: "meta/llama-4" }],
        }),
      })),
    );

    const { lastFrame, stdin, unmount, onProvidersSelectChatModel } = makeApp();
    await tick();

    // First /model from the chat editor.
    stdin.write("/model");
    await tick();
    stdin.write("\r");
    await tick();
    await tick();
    let frame = strip(lastFrame() ?? "");
    expect(frame).toContain("Cloud text models");
    expect(frame).toContain("provider: nous");
    expect(frame).toContain("filter:");
    // Focused filter advertises its keys.
    expect(frame).toContain("type to filter");
    expect(frame).toContain("qwen/qwen-3.5");

    // Typing goes into the filter, not the chat editor.
    stdin.write("qwen");
    await tick();
    frame = strip(lastFrame() ?? "");
    expect(frame).toContain("filter: qwen");
    expect(frame).toContain("qwen/qwen-3.5");
    expect(frame).not.toContain("meta/llama-4");

    // Esc exits filter mode; the list and text stay.
    stdin.write("");
    await tick();
    frame = strip(lastFrame() ?? "");
    expect(frame).not.toContain("type to filter");
    expect(frame).toContain("filter: qwen");

    // Second /model, typed from the LLM tab: the "/" hotkey seeds the
    // editor buffer, the typed letters must land AFTER the seeded slash.
    stdin.write("/");
    await tick();
    stdin.write("model");
    await tick();
    stdin.write("\r");
    await tick();
    await tick();
    frame = strip(lastFrame() ?? "");
    expect(frame).toContain("type to filter");
    expect(frame).toContain("provider: nous");

    // Enter selects the model under the cursor via the real callback.
    stdin.write("\r");
    await tick();
    expect(onProvidersSelectChatModel).toHaveBeenCalled();

    unmount();
  });

  it("windows 354 models to a dozen visible rows with an (n/N) counter", async () => {
    currentConfig = configWithNous("https://app-354.nous.example");
    const models = Array.from({ length: 354 }, (_, i) =>
      `vendor/model-${String(i).padStart(3, "0")}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: models.map((id) => ({ id })) }),
      })),
    );

    const { lastFrame, stdin, unmount } = makeApp();
    await tick();
    stdin.write("/model");
    await tick();
    stdin.write("\r");
    await tick();
    await tick();

    const frame = strip(lastFrame() ?? "");
    // 354 catalog models + the current (typoed) model = 355 rows total.
    expect(frame).toContain("(1/355)");
    // The window adapts to the test terminal's height; the exact
    // 12-row window is pinned by the LlmModeRows component test.
    const visibleModels = frame
      .split("\n")
      .filter((line) => line.includes("vendor/model-"));
    expect(visibleModels.length).toBeGreaterThanOrEqual(2);
    expect(visibleModels.length).toBeLessThanOrEqual(12);

    // Filtering narrows the counter to the filtered/total form.
    stdin.write("353");
    await tick();
    const filtered = strip(lastFrame() ?? "");
    expect(filtered).toContain("vendor/model-353");
    expect(filtered).toContain("(1/1 of 355)");

    unmount();
  });
});
