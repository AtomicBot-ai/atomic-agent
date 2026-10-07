import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Ink resolves chalk's colour level once, at import time, from the
// terminal it thinks it has — and under a test runner that is none, so
// every frame comes back stripped. `vi.hoisted` runs before the imports
// below, which is the only place the flag can still be read.
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { theme } from "../theme/theme.js";
import { AssistantBubble } from "./assistant-bubble.js";
import { UserBubble } from "./user-bubble.js";

/** The SGR sequence Ink emits for a hex foreground. */
function ink(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `[38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}m`;
}

function frame(element: Parameters<typeof render>[0]): string {
  const { lastFrame, unmount } = render(element);
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

describe("the chat bubbles under fusion", () => {
  it("paint the user border orange but keep the YOU label in the user colour", () => {
    const out = frame(<UserBubble text="hi" fusion />);
    expect(out).toContain(`${ink(theme.colors.user)}  YOU`);
    expect(out).toContain(`${ink(theme.colors.warnStrong)}│`);
    expect(out).not.toContain(`${ink(theme.colors.user)}│`);
  });

  it("paint the AGENT label, the border and the footer glyph orange", () => {
    const out = frame(<AssistantBubble text="done" toolSteps={2} fusion />);
    const orange = ink(theme.colors.warnStrong);
    expect(out).toContain(`${orange}  AGENT`);
    expect(out).toContain(`${orange}│`);
    expect(out).toContain(`${orange}●`);
    expect(out).not.toContain(`${ink(theme.colors.assistant)}  AGENT`);
  });

  it("stay in their own colours off fusion", () => {
    const user = frame(<UserBubble text="hi" />);
    expect(user).toContain(`${ink(theme.colors.user)}│`);
    expect(user).not.toContain(ink(theme.colors.warnStrong));
    const agent = frame(<AssistantBubble text="done" toolSteps={1} />);
    expect(agent).toContain(`${ink(theme.colors.assistant)}  AGENT`);
    expect(agent).not.toContain(ink(theme.colors.warnStrong));
  });
});
