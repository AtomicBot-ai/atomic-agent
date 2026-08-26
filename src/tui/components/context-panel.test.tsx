import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ContextUsageView } from "../select-context-usage.js";
import { ContextPanel } from "./context-panel.js";

const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

const SECTIONS = [
  { label: "prompt scaffold", tokens: 5240 },
  { label: "conversation", tokens: 31_880 },
  { label: "recalled memory", tokens: 2150 },
  { label: "session facts", tokens: 610 },
];

function usage(overrides: Partial<ContextUsageView> = {}): ContextUsageView {
  return {
    tokens: 39_880,
    contextWindow: 131_072,
    percent: 30,
    conversationTokens: 31_880,
    conversationCap: 32_000,
    conversationPercent: 100,
    capSource: "config",
    droppedTurns: 0,
    sections: SECTIONS,
    ...overrides,
  };
}

function lines(
  view: ContextUsageView | null,
  columns = 100,
  rows = 24,
  reserved: number | null = 4096,
  onSetAuto?: () => void,
): string[] {
  const { lastFrame, unmount } = render(
    <Box width={columns} height={rows} flexDirection="column">
      <ContextPanel
        usage={view}
        availableRows={rows}
        availableColumns={columns}
        reservedForReply={reserved}
        {...(onSetAuto ? { onSetAuto } : {})}
      />
    </Box>,
  );
  const out = (lastFrame() ?? "")
    .replace(SGR, "")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  unmount();
  return out;
}

describe("ContextPanel", () => {
  it("titles itself with the prompt total and the window", () => {
    expect(lines(usage())[1]).toContain("context · 39.9k of 131.1k window · 30%");
  });

  it("lists every section with its tokens and share", () => {
    const body = lines(usage()).join("\n");
    expect(body).toContain("conversation          31.9k  24%");
    expect(body).toContain("prompt scaffold        5.2k   4%");
  });

  /**
   * Scaled against the window, every bar but the transcript's rounds to
   * nothing. Scaled against the largest section they say what the panel
   * exists to say — where the tokens went, relative to each other.
   */
  it("scales the row gauges to the largest section", () => {
    const body = lines(usage());
    const conversation = body.find((l) => l.includes("conversation")) ?? "";
    const recalled = body.find((l) => l.includes("recalled memory")) ?? "";
    expect(conversation).toContain("==========");
    expect(recalled).toContain(" =");
    expect(recalled).not.toContain("==");
  });

  /** A section that rounds to nothing still cost something. */
  it("writes <1% rather than 0% for a section that rounds away", () => {
    expect(lines(usage()).join("\n")).toContain("session facts           610  <1%");
  });

  it("accounts for the reply reservation and what is left", () => {
    const body = lines(usage()).join("\n");
    expect(body).toContain("reserved for reply     4.1k");
    // 131072 − 39880 − 4096 = 87096
    expect(body).toContain("free                  87.1k");
  });

  /**
   * The estimator over-counts, so a prompt can measure larger than the
   * window it fit into. Negative free space would read as a bug.
   */
  it("floors free space at zero when the estimate overshoots", () => {
    const body = lines(usage({ tokens: 140_000, percent: 100 })).join("\n");
    expect(body).toContain("free                      0   0%");
  });

  it("drops the window accounting entirely when the window is unknown", () => {
    const body = lines(
      usage({ contextWindow: null, percent: null }),
      100,
      24,
      null,
    ).join("\n");
    expect(body).toContain("window unknown");
    expect(body).not.toContain("free");
    expect(body).not.toContain("%");
    // The trimming block never depended on the window.
    expect(body).toContain("6.4k of 32k before older turns go".slice(-24));
  });

  /**
   * The chip's violet is the only signal that the transcript was
   * trimmed. Without this line, "why did it change colour" has no answer
   * anywhere in the app.
   */
  it("says how many turns were trimmed", () => {
    const footer = lines(usage({ droppedTurns: 12 })).at(-2) ?? "";
    expect(footer).toContain("12 older turns trimmed");
    expect(lines(usage({ droppedTurns: 1 })).at(-2) ?? "").toContain(
      "1 older turn trimmed",
    );
    expect(lines(usage()).at(-2) ?? "").toContain("esc to close");
  });

  /**
   * Terminals have no z-index: an overlay hides what is under it only by
   * painting every one of its own cells. A row that stops at its content
   * lets the chat show through.
   */
  it("pads every interior row to the panel's full width", () => {
    const body = lines(usage());
    const width = body[0]?.trimStart().length ?? 0;
    for (const line of body) {
      expect(line.trimStart().length, line).toBe(width);
    }
  });

  it("clamps to a narrow pane without spilling out of it", () => {
    for (const columns of [40, 60, 100]) {
      for (const line of lines(usage(), columns)) {
        expect(line.length, `${columns}: ${line}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("never grows taller than the pane it floats over", () => {
    for (const rows of [8, 12, 24]) {
      expect(lines(usage(), 100, rows).length).toBeLessThanOrEqual(rows);
    }
  });
});

describe("before anything has been measured", () => {
  /**
   * The panel is reachable from the menu and from `/context` on a fresh
   * session, where no prompt has been built yet. It takes the keyboard
   * either way, so it has to paint something — an invisible modal is a
   * stuck terminal from the operator's side.
   */
  it("says so rather than rendering nothing", () => {
    const body = lines(null, 100, 24, null);
    expect(body.join("\n")).toContain("not measured yet");
    expect(body.join("\n")).toContain("esc to close");
  });

  it("still paints every cell of its own box", () => {
    const body = lines(null, 100, 24, null);
    const width = body[0]?.trimStart().length ?? 0;
    for (const line of body) {
      expect(line.trimStart().length, line).toBe(width);
    }
  });
});

describe("the trimming block", () => {
  it("says how much transcript is left before older turns go", () => {
    const body = lines(usage()).join("\n");
    expect(body).toContain("transcript         31.9k of 32k before older turns go");
  });

  /**
   * The actionable half. The effective cap is
   * `max(512, min(configured, window - everything else))`, so the number
   * alone cannot say why it is what it is — and the two causes have
   * opposite remedies.
   */
  it("names the setting, in one line, when the ceiling binds", () => {
    // It used to be a `capped by` label in the left column with its
    // value in the right — two columns and up to three lines to say one
    // sentence, in a panel whose every other row is a measurement. This
    // is not a measurement; it is the note explaining them.
    const body = lines(usage({ contextWindow: 16_384 })).join("\n");
    expect(body).toContain("capped by your agent.conversationMaxTokens setting");
    expect(body).not.toContain("capped by          ");
  });

  /**
   * The report: `llama-server -c 48000`, and the composer says 32k. The
   * panel named the knob and then spelled the fix on a third line. The
   * fix is a button now — the same sentence, made pressable.
   */
  it("offers a button when the window has room the ceiling is refusing", () => {
    const body = lines(
      usage({
        capSource: "config",
        conversationCap: 32_000,
        contextWindow: 48_000,
      }),
      100,
      24,
      4096,
      () => {},
    ).join("\n");
    expect(body).toContain("your 32k cap holds this under 48k");
    expect(body).toContain("set auto (a)");
  });

  it("does not offer the button when the ceiling is already above the window", () => {
    // Nothing to claim: the transcript is not being held below anything.
    const body = lines(
      usage({
        capSource: "config",
        conversationCap: 32_000,
        contextWindow: 16_384,
      }),
      100,
      24,
      4096,
      () => {},
    ).join("\n");
    expect(body).not.toContain("set auto");
  });

  it("does not offer the button with no handler to press", () => {
    // A button that did nothing when pressed would be worse than none.
    const body = lines(
      usage({ capSource: "config", conversationCap: 32_000, contextWindow: 48_000 }),
    ).join("\n");
    expect(body).not.toContain("set auto");
  });

  it("says the cap is auto rather than naming a knob", () => {
    const body = lines(
      usage({
        capSource: "auto",
        conversationCap: 38_992,
        contextWindow: 48_000,
      }),
    ).join("\n");
    expect(body).toContain("capped by the 48k window — auto, no ceiling set");
    expect(body).not.toContain("agent.conversationMaxTokens");
  });

  it("names the window, with its size, when the window binds", () => {
    const body = lines(
      usage({ capSource: "window", conversationCap: 9000, contextWindow: 32_768 }),
    ).join("\n");
    expect(body).toContain("capped by the model's 32.8k window");
  });

  it("calls the floor what it is", () => {
    const body = lines(usage({ capSource: "floor", conversationCap: 512 })).join(
      "\n",
    );
    expect(body).toContain("window too small for this prompt");
  });

  it("is absent entirely before a prompt has set a cap", () => {
    const body = lines(usage({ conversationCap: null, capSource: null })).join("\n");
    expect(body).not.toContain("before older turns go");
    expect(body).not.toContain("capped by");
  });
});
