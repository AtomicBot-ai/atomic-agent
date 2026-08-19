import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { toSlashCommands } from "../menu/menu-registry.js";
import { SplashBanner } from "./splash-banner.js";

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

describe("SplashBanner", () => {
  it("renders the plus-mark middle bar and the wordmark", () => {
    const { lastFrame } = render(<SplashBanner />);
    const frame = strip(lastFrame() ?? "");
    // Middle bar of the plus — longest uninterrupted `:` run in the art.
    expect(frame).toContain("::::::::::::::::::::::::::::::::::");
    // Both halves of the `ATOMIC AGENT` half-block wordmark.
    expect(frame).toContain("▄▀█ ▀█▀ █▀█");
    expect(frame).toContain("▄▀█ █▀▀ █▀▀");
    expect(frame).toContain("Local AI-First Agent");
  });

  it("advertises the core slash commands and hotkeys", () => {
    const { lastFrame } = render(<SplashBanner />);
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("/help");
    expect(frame).toContain("/sessions");
    expect(frame).toContain("/new");
    expect(frame).toContain("/model");
    expect(frame).toContain("Ctrl+C");
  });

  // The banner is a short tip-list, not the full command catalogue — which
  // slash commands it picks is a copy decision that changes freely. What must
  // not drift is that every command it prints is a real one, so a renamed or
  // deleted command cannot leave the welcome screen advertising a dead verb.
  it("only advertises slash commands that exist in the menu registry", () => {
    const { lastFrame } = render(<SplashBanner />);
    const frame = strip(lastFrame() ?? "");
    const registered = new Set(toSlashCommands().map((c) => c.name));
    const advertised = [...frame.matchAll(/\/([a-z][a-z0-9-]*)/g)].map(
      (m) => m[1]!,
    );
    expect(advertised.length).toBeGreaterThan(0);
    for (const name of advertised) {
      expect(registered, `/${name} is advertised but not registered`).toContain(
        name,
      );
    }
  });
});
