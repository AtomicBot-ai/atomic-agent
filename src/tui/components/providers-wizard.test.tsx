import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
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
      <ProvidersWizard wizard={chatModelStep("https://many.example", 20)} />,
    );
    await flush();

    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("30 from https://many.example/v1/models");
    // ids are listed sorted; cursor 20 lands on the 21st of them
    expect(text).toContain("> model-28");
    expect(text).toContain("(21/30)");
    expect(text).not.toContain("model-10");
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
