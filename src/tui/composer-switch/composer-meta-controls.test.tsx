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
    // classic-dark rail, which is the whole reason this row was dim.
    expect(out).not.toContain(ink(theme.colors.accentSoft));
  });

  it("shows the dot alone on a local backend — no probe word", () => {
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
    // The row used to spell the probe out (`○ local down`). It reported
    // `down` against working daemons often enough to be noise, so the
    // dot is all that is left of it here — the Models pane still states
    // the probe in full.
    expect(plain(out)).toContain("○ local");
    expect(plain(out)).not.toContain("down");
    // Rail-aware grey: `muted` was chosen against the normal ground and
    // reads at ~2.5:1 on the rail.
    expect(out).toContain(ink(theme.colors.railMuted));
    expect(out).not.toContain(ink(theme.colors.muted));
  });

  it("stays silent — no dot, no word — while nothing has been probed", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={{ kind: "custom", status: "unknown" }}
          provider="llama.cpp"
          model={null}
        />
      </Box>,
    );
    const out = plain(lastFrame() ?? "");
    unmount();
    // The unknown glyph is the same `·` the row separates words with;
    // drawing it made the status indistinguishable from punctuation.
    expect(out.trimStart().startsWith("custom")).toBe(true);
    expect(out).not.toContain("· custom");
    expect(out).not.toContain("unknown");
  });

  it("gives cloud its dot but never a word no probe stands behind", () => {
    const out = plain(frame());
    expect(out).toContain("● cloud");
    expect(out).not.toContain("healthy");
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

describe("the model slot's download call to action", () => {
  it("replaces the model with `download model` when nothing is on disk", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={{ kind: "local", status: "unreachable" }}
          provider={null}
          model="qwen-3.5-4b"
          needsModelDownload
        />
      </Box>,
    );
    const out = plain(lastFrame() ?? "");
    unmount();
    expect(out).toContain("○ local · download model");
    // The catalog id is what the config *selected*, not what exists —
    // showing it next to an empty models directory is the bug.
    expect(out).not.toContain("qwen-3.5-4b");
  });

  it("draws the call to action in the rail's warn, not the route's own tone", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={{ kind: "local", status: "unknown" }}
          provider={null}
          model={null}
          needsModelDownload
        />
      </Box>,
    );
    const out = lastFrame() ?? "";
    unmount();
    // `railWarn`, not `warnStrong`: this text sits on the rail ground,
    // and `warnStrong` is the warn picked to be read on the page.
    expect(out).toContain(`${ink(theme.colors.railWarn)}download model`);
    expect(out).not.toContain(`${ink(theme.colors.warnStrong)}download model`);
    expect(out).not.toContain(`${ink(theme.colors.railForeground)}download model`);
  });

  it("still renders the route when the CTA is the only thing to say", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={null}
          provider={null}
          model={null}
          needsModelDownload
        />
      </Box>,
    );
    const out = plain(lastFrame() ?? "");
    unmount();
    // No backend and no provider means no leading separator either — a
    // row starting in " · " reads as a dropped label.
    expect(out.trim()).toBe("download model");
  });
});
