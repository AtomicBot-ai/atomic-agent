import { describe, expect, it } from "vitest";
import type { ToolContext } from "../tool-registry.js";
import { DEFAULT_TOOL_DESCRIPTORS_B } from "../../prompt/default-tool-descriptors-b.js";
import { parseUiSpec, uiRenderTool, uiSpecOf, uiSpecText, UI_RENDER_TOOL } from "./index.js";

const ctx = (): ToolContext => ({ workingDir: "/tmp", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });

describe("ui.render (ATO-2457)", () => {
  it("shows a decision: the spec on details.ui, its text form as the result", async () => {
    const result = await uiRenderTool.run({
      kind: "decision",
      title: "Which plan?",
      options: [{ label: "Fast", description: "ships today" }, { label: "Safe", message: "Take the safe plan, with tests" }],
    }, ctx());
    expect(result.status).toBe("ok");
    expect(uiSpecOf(result)).toEqual({
      kind: "decision",
      title: "Which plan?",
      options: [{ label: "Fast", description: "ships today" }, { label: "Safe", message: "Take the safe plan, with tests" }],
    });
    expect(result.summary).toContain("Choice: Which plan?");
    expect(result.summary).toContain("1. Fast: ships today");
    expect(result.summary).toContain("2. Safe");
    expect(result.summary).toContain("next message");
  });

  it("guesses the kind and takes bare strings as labels", () => {
    expect(parseUiSpec({ title: "Pick", options: ["A", "B"] })).toEqual({ kind: "decision", title: "Pick", options: [{ label: "A" }, { label: "B" }] });
    expect(parseUiSpec({ title: "Who", fields: ["Name"] }).kind).toBe("form");
    expect(parseUiSpec({ title: "Hits", cards: [{ title: "One" }] }).kind).toBe("cards");
  });

  it("checks a form's fields: types, select options, a starting value among them, unique names", () => {
    const spec = parseUiSpec({
      kind: "form",
      title: "Trip",
      submit: "Book",
      fields: [
        { label: "City", required: true, placeholder: "Paris" },
        { label: "Class", options: ["Economy", "Business"], value: "Business" },
        { label: "City", type: "text" },
        { label: "Window seat", type: "checkbox", value: true },
      ],
    });
    expect(spec.fields!.map((f) => [f.name, f.type])).toEqual([["city", "text"], ["class", "select"], ["city-2", "text"], ["window-seat", "checkbox"]]);
    expect(spec.fields![1]!.value).toBe("Business");
    expect(spec.fields![3]!.value).toBe("true");
    expect(uiSpecText(spec)).toContain("  - Class (one of: Economy, Business) [Business]");
    expect(uiSpecText(spec)).toContain("  [Book]");
    expect(() => parseUiSpec({ kind: "form", title: "x", fields: [{ label: "Class", options: ["A"], value: "B" }] })).toThrow(/not one of its options/);
    expect(() => parseUiSpec({ kind: "form", title: "x", fields: [{ label: "When", type: "time" }] })).toThrow(/not supported/);
  });

  it("gives a card action a message when the model left it out", () => {
    const spec = parseUiSpec({ kind: "cards", title: "Flights", cards: [{ title: "AF 1234", meta: "09:10", action: { label: "Book" } }] });
    expect(spec.cards![0]!.action).toEqual({ label: "Book", message: "Book: AF 1234" });
    expect(uiSpecText(spec)).toContain("1. AF 1234 · 09:10");
  });

  it("answers a bad spec with an error the model can act on, and no details.ui", async () => {
    for (const args of [
      { kind: "decision", title: "One?", options: ["Only"] },
      { kind: "decision", title: "Dup", options: ["A", "a"] },
      { kind: "slider", title: "x" },
      { kind: "cards", title: "", cards: [{ title: "x" }] },
      { kind: "decision", title: "Many", options: Array.from({ length: 9 }, (_, i) => `o${i}`) },
    ]) {
      const result = await uiRenderTool.run(args, ctx());
      expect(result.status, JSON.stringify(args)).toBe("error");
      expect(result.summary).toMatch(/^ui\.render: /);
      expect(uiSpecOf(result)).toBeUndefined();
    }
  });

  it("is read-only and has a rare-tier descriptor that points a blocking question at ask_user", () => {
    expect(uiRenderTool.name).toBe(UI_RENDER_TOOL);
    expect(uiRenderTool.readonly).toBe(true);
    const d = DEFAULT_TOOL_DESCRIPTORS_B.find((x) => x.name === UI_RENDER_TOOL);
    expect(d?.tier).toBe("rare");
    expect(d?.summary).toContain("ask_user");
  });
});
