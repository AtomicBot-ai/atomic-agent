import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { toSlashCommands } from "../menu/menu-registry.js";
import { SplashBanner } from "./splash-banner.js";

function strip(value: string): string {
  return value
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\]8;;[^]*/g, "");
}

function frameAt(columns: number, rows: number): string {
  const { lastFrame } = render(<SplashBanner size={{ columns, rows }} />);
  return strip(lastFrame() ?? "");
}

describe("SplashBanner", () => {
  it("renders the plus-mark middle bar and the wordmark on a roomy surface", () => {
    const frame = frameAt(96, 40);
    // Middle bar of the plus — longest uninterrupted `:` run in the art.
    expect(frame).toContain("::::::::::::::::::::::::::::::::::");
    // Both halves of the `ATOMIC AGENT` half-block wordmark.
    expect(frame).toContain("▄▀█ ▀█▀ █▀█");
    expect(frame).toContain("▄▀█ █▀▀ █▀▀");
    expect(frame).toContain("Local AI-First Agent");
  });

  it("advertises the core slash commands", () => {
    const frame = frameAt(96, 40);
    expect(frame).toContain("/help");
    expect(frame).toContain("/sessions");
    expect(frame).toContain("/new");
    expect(frame).toContain("/model");
    expect(frame).toContain("/tasks");
    expect(frame).toContain("/import");
    // The two plain-hotkey rows (Enter, Ctrl+C x2) are gone: every row
    // is now a command a click can put in the composer, and the hint
    // strip carries both keys at the foot of the screen anyway.
    expect(frame).not.toContain("Ctrl+C");
    expect(frame).not.toMatch(/•\s+Enter/u);
  });

  it("keeps the most useful tips when the surface is too short for all of them", () => {
    const frame = frameAt(96, 16);
    expect(frame).toContain("/help");
    expect(frame).toContain("/sessions");
    // The tail of the list is what gives way first.
    expect(frame).not.toContain("/import");
  });

  it("swaps in terse descriptions on a narrow surface", () => {
    const frame = frameAt(44, 20);
    expect(frame).toContain("/help");
    expect(frame).toContain("all commands");
    expect(frame).not.toContain("list all slash commands");
  });

  it("keeps the tips and drops the mark when four rows is all there is", () => {
    // The mark is scaled artwork at every size now — the smallest is 4
    // rows, so on a 4-row surface it would leave nothing for the tips
    // and Ink would paint it over the chat above. Tips win.
    const frame = frameAt(38, 4);
    expect(frame).toContain("/help");
    expect(frame).not.toMatch(/:::|[█▀▄]/u);
  });

  it("still shows a brand mark and a tip once there is room for both", () => {
    const frame = frameAt(38, 8);
    expect(frame).toMatch(/:::|[█▀▄]/u);
    expect(frame).toContain("/help");
  });

  it("measures the terminal itself when no size is given", () => {
    const { lastFrame } = render(<SplashBanner />);
    const frame = strip(lastFrame() ?? "");
    expect(frame).toMatch(/:::|[█▀▄]/u);
    expect(frame).toContain("/help");
  });

  // The banner is a short tip-list, not the full command catalogue — which
  // slash commands it picks is a copy decision that changes freely. What must
  // not drift is that every command it prints is a real one, so a renamed or
  // deleted command cannot leave the welcome screen advertising a dead verb.
  it("only advertises slash commands that exist in the menu registry", () => {
    const frame = frameAt(96, 40);
    // Aliases count as real: `/run` resolves to `/chat` at dispatch, so
    // advertising an alias is not a dead verb.
    const registered = new Set(
      toSlashCommands().flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    );
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
