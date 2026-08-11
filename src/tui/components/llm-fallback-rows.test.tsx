import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { FallbackLinkRow } from "../llm-panel/fallback/fallback-panel-state.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { LlmModeRows } from "./llm-mode-rows.js";

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function link(providerId: string, over: Partial<FallbackLinkRow> = {}): FallbackLinkRow {
  return {
    providerId,
    modelLabel: null,
    kind: "openrouter",
    isActive: false,
    isAppendedLocal: false,
    ...over,
  };
}

function fallbackState(patch: Partial<TuiState["fallbackPanel"]> = {}): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    llmPanel: { ...base.llmPanel, mode: "fallback" },
    fallbackPanel: { ...base.fallbackPanel, ...patch },
  };
}

describe("FallbackRows", () => {
  it("renders links in order with the active head marked and a numbered list", () => {
    const state = fallbackState({
      links: [
        link("cloud-a", { isActive: true, modelLabel: "vendor/a" }),
        link("cloud-b", { modelLabel: "vendor/b" }),
        link("local-llama", { kind: "llama-server", isAppendedLocal: true }),
      ],
      addableProviderIds: ["cloud-c"],
      appendLocal: true,
    });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Fallback chain");
    // Order preserved with 1-based numbering.
    const aAt = out.indexOf("1. cloud-a");
    const bAt = out.indexOf("2. cloud-b");
    const lAt = out.indexOf("3. local-llama");
    expect(aAt).toBeGreaterThan(-1);
    expect(bAt).toBeGreaterThan(aAt);
    expect(lAt).toBeGreaterThan(bAt);
    expect(out).toContain("active (primary)");
    expect(out).toContain("local last resort (appendLocal)");
    expect(out).toContain("+ add link");
  });

  it("shows the empty-state hint when no chain is configured", () => {
    const state = fallbackState({ links: [], addableProviderIds: ["cloud-a"] });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("No chain configured");
  });

  it("surfaces the last fallover as a live status line (no invented countdown)", () => {
    const state = fallbackState({
      links: [link("cloud-a", { isActive: true })],
      lastSwitch: { direction: "away", from: "cloud-a", to: "cloud-b", reason: "429" },
    });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("failed over cloud-a");
    expect(out).toContain("cloud-b");
    expect(out).not.toMatch(/retry in \d/);
  });

  it("says on primary when nothing has failed over", () => {
    const state = fallbackState({ links: [link("cloud-a", { isActive: true })] });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    expect(strip(lastFrame() ?? "")).toContain("on primary (no fallover this session)");
  });

  it("renders the add-link picker when open", () => {
    const state = fallbackState({
      links: [link("cloud-a", { isActive: true })],
      addableProviderIds: ["cloud-b", "cloud-c"],
      addPicker: { cursor: 1 },
    });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Add fallback link");
    expect(out).toContain("cloud-b");
    expect(out).toContain("cloud-c");
  });

  it("shows the appendLocal toggle state", () => {
    const state = fallbackState({
      links: [link("cloud-a", { isActive: true })],
      appendLocal: false,
    });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    expect(strip(lastFrame() ?? "")).toContain("append local as last resort: off");
  });
});
