import { describe, expect, it, vi } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { DEFAULT_FALLBACK_TIMING } from "../../llm/fallback/fallback-config.js";
import { ProviderFallbackChain, type ProviderSwitchNotice } from "../../llm/fallback/provider-fallback-chain.js";
import { OpenAiHttpError } from "../../llm/provider/openai/openai-http.js";
import {
  createLocalFirstEscalation,
  localFirstTurnPolicy,
  SPENT_BUDGET_CEILING_USD,
  withLocalFirstWatch,
} from "./local-first-escalation.js";

const empty = { type: "empty_completion_recovered", stepIndex: 1, attempt: 1, budget: 2 } as AgentLoopEvent;

function rig() {
  const notices: ProviderSwitchNotice[] = [];
  const chain = new ProviderFallbackChain({
    resolve: () => ({ chain: ["openrouter"], timing: DEFAULT_FALLBACK_TIMING }),
    noticeSink: (n) => notices.push(n),
  });
  const info = vi.fn();
  const escalation = createLocalFirstEscalation({ chain, logger: { info } });
  return { chain, notices, info, escalation };
}

describe("local-first escalation (ATO-2434)", () => {
  it("a weak local answer moves the rest of the turn to the cloud", () => {
    const { chain, notices, info, escalation } = rig();
    chain.setTurnPrimary("s1", "local");
    escalation.begin("s1", "local");
    escalation.observe("s1", empty);
    expect(chain.pickProvider("s1").providerId).toBe("openrouter");
    expect(notices[0]).toMatchObject({ direction: "away", from: "local", to: "openrouter", reason: "the local model's answer was empty" });
    expect(info.mock.calls[0]?.[1]).toMatchObject({ sessionId: "s1", signal: "empty", providerId: "openrouter" });
  });

  it("does nothing for a turn it was not told about, or after end", () => {
    const { chain, escalation } = rig();
    chain.setTurnPrimary("s1", "local");
    escalation.observe("s1", empty);
    escalation.observe(undefined, empty);
    escalation.begin("s1", "local");
    escalation.end("s1");
    escalation.observe("s1", empty);
    expect(chain.pickProvider("s1").providerId).toBe("local");
  });

  it("does nothing once a provider failure already moved the turn", () => {
    const { chain, notices, escalation } = rig();
    chain.setTurnPrimary("s1", "local");
    escalation.begin("s1", "local");
    chain.advanceFrom("local", new OpenAiHttpError("down", 503, "http://127.0.0.1:1", false, null, "local"), "s1");
    escalation.observe("s1", empty);
    expect(notices).toHaveLength(1);
  });

  it("watches each event before it is fanned out", () => {
    const order: string[] = [];
    const watch = withLocalFirstWatch(
      { observe: (id, e) => order.push(`watch:${id}:${e.type}`) },
      () => "s1",
      (e) => order.push(`emit:${e.type}`),
    );
    watch(empty);
    expect(order).toEqual(["watch:s1:empty_completion_recovered", "emit:empty_completion_recovered"]);
  });
});

describe("localFirstTurnPolicy (ATO-2434)", () => {
  it("escalates with no ceiling by default", () => {
    expect(localFirstTurnPolicy({ fallback: undefined, todayUsd: 0, taskMaxCostUsd: 0 })).toEqual({ escalate: true });
  });

  it("can be told not to escalate", () => {
    expect(localFirstTurnPolicy({ fallback: { localFirstEscalate: false }, todayUsd: 0, taskMaxCostUsd: 0 }).escalate).toBe(false);
  });

  it("takes the smallest of the turn ceiling, what is left of the day and the task ceiling", () => {
    expect(
      localFirstTurnPolicy({ fallback: { localFirstMaxTurnUsd: 0.5, localFirstMaxDayUsd: 2 }, todayUsd: 1.8, taskMaxCostUsd: 0 }),
    ).toEqual({ escalate: true, maxCostUsd: expect.closeTo(0.2, 6) });
    expect(
      localFirstTurnPolicy({ fallback: { localFirstMaxTurnUsd: 0.5 }, todayUsd: 0, taskMaxCostUsd: 0.25 }),
    ).toEqual({ escalate: true, maxCostUsd: 0.25 });
  });

  it("a spent day keeps weak answers local and stops the turn at its first priced step", () => {
    expect(localFirstTurnPolicy({ fallback: { localFirstMaxDayUsd: 2 }, todayUsd: 2.5, taskMaxCostUsd: 0 })).toEqual({
      escalate: false,
      maxCostUsd: SPENT_BUDGET_CEILING_USD,
    });
  });
});
