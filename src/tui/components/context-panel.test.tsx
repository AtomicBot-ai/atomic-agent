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
    pairs: 8,
    pairsCap: 20,
    droppedPairs: 0,
    // Eight tasks at a flat 4k each, so a projection is easy to predict:
    // N tasks costs `overhead + N * 4000`.
    pairCosts: [4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000],
    overheadTokens: 8000,
    sections: SECTIONS,
    ...overrides,
  };
}

function lines(
  view: ContextUsageView | null,
  columns = 100,
  rows = 24,
  reserved: number | null = 4096,
  pairsDraft: number | null = null,
  onStepPairs?: (delta: number) => void,
): string[] {
  const { lastFrame, unmount } = render(
    <Box width={columns} height={rows} flexDirection="column">
      <ContextPanel
        usage={view}
        availableRows={rows}
        availableColumns={columns}
        reservedForReply={reserved}
        pairsDraft={pairsDraft}
        {...(onStepPairs ? { onStepPairs } : {})}
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
    // The selector never depended on the window: how many tasks to send
    // is a choice you can still make when nobody published a length.
    expect(body).toContain("tasks per turn");
  });

  /**
   * The chip's violet is the only signal that the transcript was
   * trimmed. Without this line, "why did it change colour" has no answer
   * anywhere in the app.
   */
  it("says how many tasks were dropped", () => {
    // Tasks, not rows: rows are what the packer counts, tasks are what
    // the operator set the limit in and the only unit that answers "how
    // far back can it still see".
    const footer = lines(usage({ droppedPairs: 12 })).at(-2) ?? "";
    expect(footer).toContain("12 earlier tasks dropped");
    expect(lines(usage({ droppedPairs: 1 })).at(-2) ?? "").toContain(
      "1 earlier task dropped",
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


/**
 * What stood below the rule was three lines of prose about a token
 * ceiling — a `transcript` measurement, a sentence naming
 * `agent.conversationMaxTokens`, and a button that set it to auto. All
 * of it asked the operator to reason in tokens about a limit nobody
 * pictures in tokens.
 *
 * One control replaces the lot: the number of tasks the next prompt will
 * carry, with the cost of that choice recalculated above it as they
 * move.
 */
describe("the task selector", () => {
  it("shows how many tasks the next prompt will carry", () => {
    const body = lines(usage()).join("\n");
    expect(body).toContain("tasks per turn");
    expect(body).toContain("20");
  });

  it("offers a button either side of the number", () => {
    const body = lines(usage()).join("\n");
    expect(body).toContain("−");
    expect(body).toContain("+");
  });

  it("has nothing left of the token ceiling it replaced", () => {
    const body = lines(usage()).join("\n");
    expect(body).not.toContain("set auto");
    expect(body).not.toContain("capped by");
    expect(body).not.toContain("conversationMaxTokens");
    expect(body).not.toContain("before older turns go");
    expect(body).not.toContain("transcript");
  });

  it("says which keys work it", () => {
    expect(lines(usage()).join("\n")).toContain("- / + to change");
  });

  it("shows the selection being made, not the one last measured", () => {
    const body = lines(usage(), 100, 24, 4096, 4).join("\n");
    expect(body).toContain("  4 ");
  });
});

/**
 * The point of the control: the numbers above it are the consequence of
 * the choice, so they have to move with it.
 */
describe("recalculating as the selector moves", () => {
  const percentOf = (body: string): number =>
    Number(/window · (\d+)%/.exec(body)?.[1] ?? "-1");

  it("recalculates the whole readout, not one line of it", () => {
    // overhead 8000 + 4 tasks x 4000 = 24000 of 131072 = 18%.
    const body = lines(usage(), 100, 24, 4096, 4).join("\n");
    expect(percentOf(body)).toBe(18);
    expect(body).toContain("24k of 131.1k window");
  });

  it("moves the conversation row with it", () => {
    const body = lines(usage(), 100, 24, 4096, 2).join("\n");
    // Two tasks at 4k. The row the transcript lives in must follow the
    // selector, or the breakdown contradicts the total above it.
    expect(body).toMatch(/conversation\s+8k/);
  });

  it("gives the window back as tasks come off", () => {
    const freeOf = (draft: number | null): string =>
      lines(usage(), 100, 24, 4096, draft).find((l) => l.includes("free")) ?? "";
    expect(freeOf(8)).not.toBe(freeOf(2));
    expect(freeOf(2)).toContain("%");
  });

  it("shrinks monotonically as the operator asks for less", () => {
    const at = (draft: number): number =>
      percentOf(lines(usage(), 100, 24, 4096, draft).join("\n"));
    expect(at(8)).toBeGreaterThan(at(4));
    expect(at(4)).toBeGreaterThan(at(1));
  });

  it("shows the measured figures until the selector is touched", () => {
    // Untouched, the panel must report what the prompt actually did —
    // projecting the same number would re-round it and show a total that
    // disagrees with the one the last turn was built against.
    const body = lines(usage()).join("\n");
    expect(percentOf(body)).toBe(30);
  });

  it("never prices more tasks than the session holds", () => {
    const all = lines(usage(), 100, 24, 4096, 8).join("\n");
    const more = lines(usage(), 100, 24, 4096, 50).join("\n");
    expect(percentOf(all)).toBe(percentOf(more));
  });
});
