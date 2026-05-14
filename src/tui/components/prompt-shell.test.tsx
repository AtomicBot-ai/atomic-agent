import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { PromptShell } from "./prompt-shell.js";

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

describe("PromptShell", () => {
  it("renders the left tail cap (╹) below the editor", () => {
    const { lastFrame, unmount } = render(
      <PromptShell
        value=""
        focus
        placeholder="hello"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("╹");
    expect(frame).toContain("hello");
    unmount();
  });

  it("shows a static placeholder when rotation list is empty", () => {
    const { lastFrame, unmount } = render(
      <PromptShell
        value=""
        focus
        placeholder="static-hint"
        rotatingPlaceholders={[]}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("static-hint");
    unmount();
  });

  it("picks one of the rotating phrases on mount", () => {
    const phrases = ["alpha-phrase", "beta-phrase", "gamma-phrase"];
    const { lastFrame, unmount } = render(
      <PromptShell
        value=""
        focus
        rotatingPlaceholders={phrases}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    const matched = phrases.some((phrase) => frame.includes(phrase));
    expect(matched).toBe(true);
    unmount();
  });

  it("hides placeholder once the buffer has content", () => {
    const { lastFrame, unmount } = render(
      <PromptShell
        value="actual user typing"
        focus
        placeholder="should-not-render"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("actual user typing");
    expect(frame).not.toContain("should-not-render");
    unmount();
  });

  it("renders the model in the meta-row when provided", () => {
    const { lastFrame, unmount } = render(
      <PromptShell
        value=""
        focus
        model="qwen3-30b-a3b-instruct"
        provider="llama.cpp"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("qwen3-30b-a3b-instruct");
    expect(frame).toContain("llama.cpp");
    unmount();
  });

  it("strips the .gguf suffix from the model label", () => {
    const { lastFrame, unmount } = render(
      <PromptShell
        value=""
        focus
        model="some-model.gguf"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("some-model");
    expect(frame).not.toContain(".gguf");
    unmount();
  });

  it("omits the meta-row when neither model nor right-slot is set", () => {
    const { lastFrame, unmount } = render(
      <PromptShell
        value=""
        focus
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).not.toContain("llama.cpp");
    unmount();
  });
});
