import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Ink resolves chalk's colour level once, at import time, from the
// terminal it thinks it has — and under a test runner that is none, so
// every frame comes back stripped. `vi.hoisted` runs before the imports
// below, which is the only place the flag can still be read. Without it
// the tone assertions in this file would be vacuously true.
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { theme } from "../theme/theme.js";
import { ComposerMetaControls } from "./composer-meta-controls.js";

/** The SGR sequence Ink emits for a hex foreground. */
function ink(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `\u001b[38;2;${r};${g};${b}m`;
}

function frame(): string {
  const { lastFrame, unmount } = render(
    <Box>
      <ComposerMetaControls
        backend={{ kind: "cloud", status: "healthy" }}
        provider="openrouter"
        model="claude-opus-5"
      />
    </Box>,
  );
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

function plain(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("the composer's route line", () => {
  it("reads backend, then provider, then model", () => {
    const text = plain(frame());
    expect(text).toContain("cloud");
    expect(text.indexOf("cloud")).toBeLessThan(text.indexOf("openrouter"));
    expect(text.indexOf("openrouter")).toBeLessThan(
      text.indexOf("claude-opus-5"),
    );
  });

  it("sets all three in the rail's text colour, not its muted one", () => {
    const out = frame();
    const bright = ink(theme.colors.railForeground);
    for (const label of ["cloud", "openrouter", "claude-opus-5"]) {
      expect(out).toContain(`${bright}${label}`);
    }
    // The provider used to be drawn in `railMuted` and the backend word
    // in a literal `gray`; the separators are the only muted thing left.
    expect(out).not.toContain(`${ink(theme.colors.railMuted)}openrouter`);
    // `accentSoft` is a fill. As text it lands around 2:1 on the
    // atomic-retro rail, which is the whole reason this row was dim.
    expect(out).not.toContain(ink(theme.colors.accentSoft));
  });

  it("keeps the health dot's own colour in front of the backend", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={{ kind: "local", status: "unreachable" }}
          provider="llama.cpp"
          model={null}
        />
      </Box>,
    );
    const out = lastFrame() ?? "";
    unmount();
    expect(plain(out)).toContain("○ local");
    expect(out).toContain(ink(theme.colors.muted));
  });

  it("renders nothing at all when there is no route to state", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls backend={null} provider={null} model={null} />
      </Box>,
    );
    expect(plain(lastFrame() ?? "").trim()).toBe("");
    unmount();
  });
});
