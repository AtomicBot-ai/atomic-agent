import { describe, expect, it } from "vitest";
import {
  buildLocalModelPicks,
  buildLocalPickRows,
  orderLocalModelPicks,
  quickStartFor,
  recommendLocalModel,
} from "./local-model-picks.js";
import {
  LOCAL_MODELS_CATALOG,
  STARTER_LOCAL_MODEL_ID,
} from "../../local-llm/index.js";

/** ATO-1045: the terminal's no-key path — the starter first, the best model after it. */
describe("first-run quick start", () => {
  it("pins the starter first and names what follows it", () => {
    const picks = orderLocalModelPicks(
      buildLocalModelPicks(16, LOCAL_MODELS_CATALOG, { quickStart: true }),
    );
    expect(picks[0]).toMatchObject({
      id: STARTER_LOCAL_MODEL_ID,
      quickStart: true,
      followedBy: recommendLocalModel(16),
      recommended: false,
    });
    expect(picks[0]!.description).toContain("no key");
    // The recommendation is still starred, right below.
    expect(picks[1]!.recommended).toBe(true);
    // Enter on the first row pulls the starter: it is an ordinary model row.
    expect(buildLocalPickRows(picks)[0]).toEqual({ kind: "model", pick: picks[0] });
  });

  it("is off unless the first-run picker asks for it", () => {
    const picks = orderLocalModelPicks(buildLocalModelPicks(16));
    expect(picks.some((p) => p.quickStart)).toBe(false);
    expect(picks[0]!.recommended).toBe(true);
  });

  it("is not offered where the starter is all there is, or does not run", () => {
    const starter = LOCAL_MODELS_CATALOG.find((d) => d.id === STARTER_LOCAL_MODEL_ID)!;
    expect(quickStartFor(2, LOCAL_MODELS_CATALOG, recommendLocalModel(2))).toBeNull();
    expect(quickStartFor(16, [starter], starter.id)).toBeNull();
    expect(quickStartFor(16, LOCAL_MODELS_CATALOG, null)).toBeNull();
  });

  it("is not offered by a catalog without the starter", () => {
    const withoutStarter = LOCAL_MODELS_CATALOG.filter((d) => d.id !== STARTER_LOCAL_MODEL_ID);
    const picks = buildLocalModelPicks(16, withoutStarter, { quickStart: true });
    expect(picks.some((p) => p.quickStart)).toBe(false);
  });
});
