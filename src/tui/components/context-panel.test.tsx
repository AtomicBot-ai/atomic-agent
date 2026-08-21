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
    droppedTurns: 0,
    sections: SECTIONS,
    ...overrides,
  };
}

function lines(
  view: ContextUsageView,
  columns = 100,
  rows = 24,
  reserved: number | null = 4096,
): string[] {
  const { lastFrame, unmount } = render(
    <Box width={columns} height={rows} flexDirection="column">
      <ContextPanel
        usage={view}
        availableRows={rows}
        availableColumns={columns}
        reservedForReply={reserved}
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
  it("titles itself with the fill and the window", () => {
    expect(lines(usage())[1]).toContain("context · 30% of 131.1k");
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
