import { EventEmitter } from "node:events";
import { Text, render as inkRender } from "ink";
import { describe, expect, it } from "vitest";
import type { ComposerBackendMeta } from "../composer-switch/composer-backend-selectors.js";
import { composerRouteWidth } from "../composer-switch/composer-meta-controls.js";
import {
  computeMetaRowBudget,
  MAX_META_EXTRA_ROWS,
  META_STACK_MIN_ROWS,
  planMetaBar,
  type MetaBarParts,
} from "./meta-bar-rows.js";
import { PromptMetaBar } from "./prompt-meta-bar.js";

/**
 * The planner decides how tall the bar is *before* Yoga lays it out, and
 * `ComposerSlot` reserves that number. The two have to be the same, so
 * this file checks the arithmetic and then checks the arithmetic against
 * a real render.
 */
const BASE: MetaBarParts = {
  barColumns: 80,
  terminalRows: 40,
  routeWidth: 20,
  noticeWidth: 0,
  contextWidth: 30,
  modeWidth: 9,
};

const parts = (over: Partial<MetaBarParts> = {}): MetaBarParts => ({
  ...BASE,
  ...over,
});

describe("computeMetaRowBudget", () => {
  it("gives a short window the single row the bar always had", () => {
    expect(computeMetaRowBudget(META_STACK_MIN_ROWS - 1)).toBe(1);
    expect(computeMetaRowBudget(24)).toBe(1);
    expect(computeMetaRowBudget(0)).toBe(1);
  });

  it("opens the extra rows at the threshold the bar already measured", () => {
    expect(computeMetaRowBudget(META_STACK_MIN_ROWS)).toBe(
      1 + MAX_META_EXTRA_ROWS,
    );
  });
});

describe("planMetaBar", () => {
  it("stays on one row while everything fits", () => {
    const plan = planMetaBar(parts({ barColumns: 200 }));
    expect(plan).toMatchObject({ rows: 1, stacked: false, routeRows: 1 });
  });

  it("stacks once the route and the readouts cannot share a line", () => {
    const plan = planMetaBar(parts({ barColumns: 50 }));
    expect(plan.stacked).toBe(true);
    expect(plan.rows).toBeGreaterThan(1);
  });

  /**
   * The switch used to be `columns < 120`, a stand-in for "a typical
   * route has stopped fitting". A wide terminal carrying a Fusion pair
   * and a full gauge is exactly the case that number got wrong.
   */
  it("stacks a wide bar whose content still does not fit", () => {
    const plan = planMetaBar(
      parts({ barColumns: 130, routeWidth: 90, contextWidth: 52 }),
    );
    expect(plan.stacked).toBe(true);
  });

  it("keeps a narrow bar on one row when its content is short", () => {
    const plan = planMetaBar(
      parts({ barColumns: 60, routeWidth: 12, contextWidth: 0, modeWidth: 9 }),
    );
    expect(plan.stacked).toBe(false);
  });

  it("truncates rather than stacking on a window with no rows to spend", () => {
    const plan = planMetaBar(parts({ barColumns: 50, terminalRows: 24 }));
    expect(plan).toMatchObject({ rows: 1, stacked: false });
  });

  it("wraps the route over as many rows as it needs", () => {
    const plan = planMetaBar(
      parts({ barColumns: 60, routeWidth: 90, contextWidth: 30 }),
    );
    expect(plan.routeRows).toBeGreaterThan(1);
  });

  /**
   * The bug this field exists for: a route handed the whole column
   * pushed the gauge out of the clipped box, and the fusion pair's
   * second leg went missing at 64 columns.
   */
  it("never lets the route take the gauge's row", () => {
    for (const routeWidth of [40, 80, 160, 400]) {
      for (const barColumns of [40, 60, 80, 120]) {
        const plan = planMetaBar(parts({ barColumns, routeWidth }));
        if (!plan.stacked) continue;
        expect(plan.routeRows).toBeLessThanOrEqual(plan.rows - 1);
        expect(plan.routeRows).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("gives the route the whole column when there is no gauge", () => {
    const plan = planMetaBar(
      parts({ barColumns: 40, routeWidth: 100, contextWidth: 0 }),
    );
    expect(plan.routeRows).toBe(plan.rows);
  });

  it("never plans more rows than the window bought", () => {
    for (const terminalRows of [16, 24, 30, 40, 60]) {
      for (const routeWidth of [10, 60, 200, 600]) {
        const plan = planMetaBar(parts({ terminalRows, routeWidth }));
        expect(plan.rows).toBeLessThanOrEqual(
          computeMetaRowBudget(terminalRows),
        );
        expect(plan.rows).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("survives a zero-width bar without dividing by it", () => {
    expect(planMetaBar(parts({ barColumns: 0 }))).toMatchObject({ rows: 1 });
    expect(planMetaBar(parts({ barColumns: -5 }))).toMatchObject({ rows: 1 });
  });

  it("counts the left slot against the route's line", () => {
    const withoutNotice = planMetaBar(
      parts({ barColumns: 70, routeWidth: 40, contextWidth: 0, modeWidth: 0 }),
    );
    const withNotice = planMetaBar(
      parts({
        barColumns: 70,
        routeWidth: 40,
        contextWidth: 0,
        modeWidth: 0,
        noticeWidth: 40,
      }),
    );
    expect(withoutNotice.stacked).toBe(false);
    expect(withNotice.stacked).toBe(true);
  });
});

/**
 * The load-bearing claim: the bar paints exactly `plan.rows` of content,
 * plus its padding row above and below. `ComposerSlot` reserves that
 * height, so a bar that painted one row more would hide a row of
 * transcript behind the composer, and one row fewer would leave a blank
 * stripe above it.
 */
const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

class SizedStdout extends EventEmitter {
  _lastFrame: string | undefined;
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  write = (frame: string): void => {
    this._lastFrame = frame;
  };
}

const ROUTE = {
  backend: { kind: "cloud", status: "healthy" } as ComposerBackendMeta,
  provider: "anthropic",
};

function renderedRows(fit: MetaBarParts, model: string): number {
  const stdout = new SizedStdout(fit.barColumns, fit.terminalRows);
  const instance = inkRender(
    <PromptMetaBar
      leftSlot={null}
      backend={ROUTE.backend}
      provider={ROUTE.provider}
      model={model}
      contextSlot={<Text>{"x".repeat(fit.contextWidth)}</Text>}
      modeSlot={<Text>{"y".repeat(fit.modeWidth)}</Text>}
      fit={fit}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  const frame = (stdout._lastFrame ?? "").replace(SGR, "");
  instance.unmount();
  // The bar's own `paddingY={1}` is the blank row at each end, and both
  // are lines of the frame — so a frame of `rows + 2` lines is a bar
  // that painted exactly `rows` of content.
  return frame.split("\n").length;
}

describe("the bar paints exactly the height it planned", () => {
  const MODELS = [
    "gpt-5",
    "anthropic/claude-opus-5-20260101-preview",
    "anthropic/claude-opus-5-20260101-preview ⇄ qwen3-4b-instruct-q4",
  ];
  const WIDTHS = [50, 66, 80, 100, 130];

  for (const model of MODELS) {
    it.each(WIDTHS)(`${model.slice(0, 16)}… at %i columns`, (barColumns) => {
      const fit: MetaBarParts = {
        barColumns,
        terminalRows: 40,
        routeWidth: composerRouteWidth({
          backend: ROUTE.backend,
          provider: ROUTE.provider,
          model,
        }),
        noticeWidth: 0,
        contextWidth: 30,
        modeWidth: 9,
      };
      const plan = planMetaBar(fit);
      // Two padding rows, from the bar's own `paddingY={1}`.
      expect(renderedRows(fit, model)).toBe(plan.rows + 2);
    });
  }

  it("holds on a short window, where the bar may not stack at all", () => {
    const fit: MetaBarParts = {
      barColumns: 60,
      terminalRows: 24,
      routeWidth: 90,
      noticeWidth: 0,
      contextWidth: 30,
      modeWidth: 9,
    };
    expect(renderedRows(fit, "a".repeat(80))).toBe(planMetaBar(fit).rows + 2);
  });
});
