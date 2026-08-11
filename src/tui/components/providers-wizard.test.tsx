import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { refreshAimlapiChatCatalogFromApi } from "../../llm/provider/aimlapi/fetch-aimlapi-chat-catalog.js";
import { refreshOpenRouterChatCatalogFromApi } from "../../llm/provider/openrouter/fetch-openrouter-chat-catalog.js";
import { KIND_ROW_ORDER } from "../providers/providers-wizard-phases.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { ProvidersWizardKind } from "../providers/providers-wizard-state.js";
import { ProvidersWizard } from "./providers-wizard.js";

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function chatModelStep(baseUrlLine: string, cursor = 0) {
  return {
    ...createProvidersWizardState("add", { kind: "openai-compatible" }),
    phase: "chat_model_line" as const,
    baseUrlLine,
    cursor,
  };
}

function cloudPickStep(kind: ProvidersWizardKind, cursor: number) {
  return {
    ...createProvidersWizardState("add", { kind }),
    phase: "pick_chat_model" as const,
    cursor,
  };
}

/** Count rendered option rows by a substring every option label carries. */
function countRows(text: string, needle: string): number {
  return text.split("\n").filter((line) => line.includes(needle)).length;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("ProvidersWizard chat model step", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("windows a long discovered model list around the cursor", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `model-${i + 1}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: ids.map((id) => ({ id })) }),
      })),
    );

    const { lastFrame } = render(
      // pasted with `/v1`: the header must show the URL actually requested
      <ProvidersWizard wizard={chatModelStep("https://many.example/v1", 20)} />,
    );
    await flush();

    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("30 from https://many.example/v1/models");
    // ids are listed sorted; cursor 20 lands on the 21st of them
    expect(text).toContain("> model-28");
    // The counter opens the hint, right after the movement keys.
    expect(text).toContain("↑/↓ move (21/30) · PgUp/PgDn jump");
    expect(text).not.toContain("model-10");
  });

  it("keeps the compat window when the cursor sits at the tail", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `model-${i + 1}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: ids.map((id) => ({ id })) }),
      })),
    );

    const { lastFrame } = render(
      <ProvidersWizard wizard={chatModelStep("https://many.example/v1", 29)} />,
    );
    await flush();

    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("(30/30)");
    expect(countRows(text, "model-")).toBeLessThanOrEqual(12);
  });

  it("falls back to a typed id when the server refuses the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 })),
    );

    const { lastFrame } = render(
      <ProvidersWizard wizard={chatModelStep("https://refused.example")} />,
    );
    await flush();

    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("model list unavailable (http 403)");
  });
});

describe("ProvidersWizard pick list counter", () => {
  it("shows the position counter on the provider list", () => {
    // 2 catalog kinds + 10 presets + manual entry. The counter is not a
    // long-list extra: hiding it below a size threshold reads as a glitch,
    // and with the preset rows the list now runs past the viewport anyway.
    const { lastFrame } = render(
      <ProvidersWizard wizard={createProvidersWizardState("add")} />,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain(
      `j/k move (1/${KIND_ROW_ORDER.length}) · Enter pick · Esc cancel`,
    );
  });
});

describe("ProvidersWizard cloud model pickers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("windows the OpenRouter picker when the live catalog has 300+ models", async () => {
    const many = Array.from({ length: 305 }, (_, i) => ({
      id: `vendor/model-${String(i).padStart(3, "0")}`,
      name: `Model ${i}`,
      context_length: 128_000,
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"] },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: many }) })),
    );
    await refreshOpenRouterChatCatalogFromApi();

    const { lastFrame } = render(
      <ProvidersWizard wizard={cloudPickStep("openrouter", 150)} />,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("> vendor/model-150");
    expect(text).toContain("(151/305)");
    expect(countRows(text, "vendor/model-")).toBeLessThanOrEqual(12);
    expect(text).not.toContain("vendor/model-000");
    expect(text).not.toContain("vendor/model-304");
  });

  it("triggers the live refresh when the picker opens cold and swaps the list in", async () => {
    // Fresh module registry: the picker must start from the static
    // catalog and fire the fetch itself, not inherit a cache warmed by
    // the tests above.
    vi.resetModules();
    const [{ ProvidersWizard: FreshWizard }, wizardState] = await Promise.all([
      import("./providers-wizard.js"),
      import("../providers/providers-wizard-state.js"),
    ]);

    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const many = Array.from({ length: 305 }, (_, i) => ({
      id: `vendor/model-${String(i).padStart(3, "0")}`,
      name: `Model ${i}`,
      context_length: 128_000,
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"] },
    }));
    const fetchMock = vi.fn(async () => {
      await gate;
      return { ok: true, json: async () => ({ data: many }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const wizard = {
      ...wizardState.createProvidersWizardState("add", { kind: "openrouter" }),
      phase: "pick_chat_model" as const,
      cursor: 0,
    };
    const { lastFrame } = render(<FreshWizard wizard={wizard} />);
    await flush();

    // While the fetch is in flight: static list + a visible loading note.
    let text = stripAnsi(lastFrame() ?? "");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://openrouter.ai/api/v1/models",
    );
    expect(text).toContain("updating model list from API");
    expect(text).toContain("openrouter/auto");
    expect(text).not.toContain("/305)");

    releaseFetch();
    await flush();

    text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("(1/305)");
    expect(text).not.toContain("updating model list from API");
  });

  it("stays on the static list without crashing when the refresh fails", async () => {
    vi.resetModules();
    const [{ ProvidersWizard: FreshWizard }, wizardState, aimlapiCatalog] =
      await Promise.all([
        import("./providers-wizard.js"),
        import("../providers/providers-wizard-state.js"),
        import("../../llm/provider/aimlapi/aimlapi-models-catalog.js"),
      ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const wizard = {
      ...wizardState.createProvidersWizardState("add", { kind: "aimlapi" }),
      phase: "pick_chat_model" as const,
      cursor: 0,
    };
    const { lastFrame } = render(<FreshWizard wizard={wizard} />);
    await flush();

    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Chat model (AI/ML API)");
    // The static head entry is still on screen and the loading note is gone.
    expect(text).toContain(aimlapiCatalog.AIMLAPI_CHAT_MODEL_ORDER[0]!);
    expect(text).not.toContain("updating model list from API");
  });

  it("windows the aimlapi picker when the live catalog has 300+ models", async () => {
    const many = Array.from({ length: 337 }, (_, i) => ({
      id: `vendor/model-${String(i).padStart(3, "0")}`,
      type: "openai/chat-completions",
      info: { name: `Model ${i}`, contextLength: 128_000 },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: many }) })),
    );
    await refreshAimlapiChatCatalogFromApi();

    const { lastFrame } = render(
      <ProvidersWizard wizard={cloudPickStep("aimlapi", 336)} />,
    );
    const text = stripAnsi(lastFrame() ?? "");
    // The cursor at the tail still sits inside a 12-row viewport.
    expect(text).toContain("> vendor/model-336");
    expect(text).toContain("(337/337)");
    expect(countRows(text, "vendor/model-")).toBeLessThanOrEqual(12);
    expect(text).not.toContain("vendor/model-000");
  });
});
