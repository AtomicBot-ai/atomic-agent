import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { NotifyPromptBox, notifyPromptHint } from "./notify-prompt-box.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("notifyPromptHint", () => {
  it("lists the three answers and Esc, marking the remembered one", () => {
    expect(notifyPromptHint(null)).toBe("t Telegram · d Discord · n no · Esc not now");
    expect(notifyPromptHint("discord")).toBe("t Telegram · d Discord ✓ · n no · Esc not now");
    expect(notifyPromptHint("off")).toBe("t Telegram · d Discord · n no ✓ · Esc not now");
  });
});

describe("NotifyPromptBox", () => {
  it("names the download, shows it moving, and lists the keys", () => {
    const view = render(
      <NotifyPromptBox
        prompt={{ label: "Qwen 3.5 4B", current: null }}
        pull={{
          kind: "chat",
          modelId: "qwen-3.5-4b",
          label: "Qwen 3.5 4B (gguf)",
          percent: 37,
          transferredBytes: 1,
          totalBytes: 3,
          error: null,
        }}
      />,
    );
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Tell you when Qwen 3.5 4B lands?");
    expect(frame).toContain("37% · the download keeps going");
    expect(frame).toContain("t Telegram · d Discord · n no · Esc not now");
  });

  it("omits the progress line when nothing is in flight", () => {
    const view = render(<NotifyPromptBox prompt={{ label: "future downloads", current: "off" }} pull={null} />);
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).not.toContain("keeps going");
    expect(frame).toContain("n no ✓");
  });
});
