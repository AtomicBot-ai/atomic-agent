import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { PromptShell } from "./prompt-shell.js";

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

describe("PromptShell", () => {
  it("closes a frame around the editor and the action bar", () => {
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
    expect(frame).toContain("╭");
    expect(frame).toContain("╰");
    expect(frame).toContain("hello");
    // The tail cap the frame replaced.
    expect(frame).not.toContain("╹");
    unmount();
  });

  it("shows the send button", () => {
    const { lastFrame, unmount } = render(
      <PromptShell
        value=""
        focus
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("send");
    unmount();
  });

  /**
   * The composer's whole height budget: four rows of chrome plus the
   * buffer. If this grows, the chat viewport shrinks — and Ink 7 will
   * overlap the lines above rather than clip, so a drift here is not a
   * cosmetic one.
   */
  it("spends eight rows on chrome regardless of the buffer", () => {
    const heightOf = (value: string): number => {
      const { lastFrame, unmount } = render(
        <PromptShell
          value={value}
          focus
          model="qwen3-30b"
          onChange={() => {}}
          onSubmit={() => {}}
        />,
      );
      const rows = strip(lastFrame() ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
      unmount();
      return rows;
    };
    expect(heightOf("one")).toBe(8);
    expect(heightOf("one\ntwo\nthree")).toBe(10);
  });

  /**
   * 60 columns is the narrowest terminal the composer has to survive:
   * the chat column is 56 wide once the root padding is taken, and the
   * rail is already hidden at that width. The meta group is the only
   * thing allowed to give up columns — a clipped button reads as a
   * rendering bug, a clipped model name reads as a long model name.
   */
  it("keeps the send button whole in a 56-column chat column", () => {
    const { lastFrame, unmount } = render(
      // A column, like the chat surface: the composer takes the
      // column's full width rather than its own intrinsic one.
      <Box width={56} flexDirection="column">
        <PromptShell
          value="explain"
          focus
          model="qwen3-30b-a3b-instruct-2507"
          provider="llama.cpp"
          leftSlot={<Text>{"● healthy"}</Text>}
          rightSlot={<Text>ctx 32768</Text>}
          onChange={() => {}}
          onSubmit={() => {}}
        />
      </Box>,
    );
    const lines = strip(lastFrame() ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(56);
    }
    // [0] border, [1] pad, [2] buffer, [3] pad, [4] bar pad,
    // [5] action bar, [6] bar pad, [7] border.
    const bar = lines[5] ?? "";
    expect(bar).toContain(" send → ");
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

  /**
   * The bar is unconditional now — it carries the buttons, so it cannot
   * come and go with the model label the way the old meta-row did
   * without the composer changing height mid-session.
   */
  it("keeps the action bar with no model and no slots", () => {
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
    expect(frame).toContain("send");
    unmount();
  });
});
