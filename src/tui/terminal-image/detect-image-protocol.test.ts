import { describe, expect, it } from "vitest";
import {
  detectImageProtocol,
  isInsideMultiplexer,
  resolveImageProtocol,
} from "./detect-image-protocol.js";

describe("detectImageProtocol", () => {
  it("finds kitty by TERM or KITTY_WINDOW_ID", () => {
    expect(detectImageProtocol({ TERM: "xterm-kitty" })).toBe("kitty");
    expect(detectImageProtocol({ TERM: "xterm-256color", KITTY_WINDOW_ID: "3" })).toBe("kitty");
  });

  it("treats Ghostty as kitty", () => {
    expect(detectImageProtocol({ TERM_PROGRAM: "ghostty" })).toBe("kitty");
    expect(detectImageProtocol({ TERM: "xterm-ghostty" })).toBe("kitty");
  });

  it("finds iTerm2 and WezTerm as the OSC 1337 protocol", () => {
    expect(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
    expect(detectImageProtocol({ LC_TERMINAL: "iTerm2" })).toBe("iterm2");
    expect(detectImageProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("iterm2");
  });

  it("says no for terminals without a protocol", () => {
    expect(detectImageProtocol({ TERM_PROGRAM: "Apple_Terminal" })).toBeNull();
    expect(detectImageProtocol({ TERM: "xterm-256color" })).toBeNull();
    expect(detectImageProtocol({})).toBeNull();
  });

  it("never answers inside tmux or screen", () => {
    expect(detectImageProtocol({ TERM: "xterm-kitty", TMUX: "/tmp/tmux-1/default,1,0" })).toBeNull();
    expect(detectImageProtocol({ TERM_PROGRAM: "iTerm.app", STY: "123.pts-0" })).toBeNull();
    expect(detectImageProtocol({ TERM: "screen-256color", KITTY_WINDOW_ID: "1" })).toBeNull();
    expect(isInsideMultiplexer({ TERM: "tmux-256color" })).toBe(true);
    expect(isInsideMultiplexer({ TERM: "xterm-kitty" })).toBe(false);
  });
});

describe("resolveImageProtocol", () => {
  const kitty = { TERM: "xterm-kitty" };

  it("is off unless the operator opts in", () => {
    expect(resolveImageProtocol(kitty)).toBeNull();
    expect(resolveImageProtocol({ ...kitty, ATOMIC_AGENT_INLINE_IMAGES: "0" })).toBeNull();
    expect(resolveImageProtocol({ ...kitty, ATOMIC_AGENT_INLINE_IMAGES: "1" })).toBe("kitty");
  });

  it("lets the opt-out win", () => {
    expect(
      resolveImageProtocol({ ...kitty, ATOMIC_AGENT_INLINE_IMAGES: "1", ATOMIC_AGENT_NO_INLINE_IMAGES: "1" }),
    ).toBeNull();
  });

  it("still needs a supporting terminal when opted in", () => {
    expect(resolveImageProtocol({ TERM_PROGRAM: "Apple_Terminal", ATOMIC_AGENT_INLINE_IMAGES: "1" })).toBeNull();
  });
});
