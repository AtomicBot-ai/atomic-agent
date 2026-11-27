import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../config/index.js";
import type { CouncilReport } from "../llm/toolcall-bench/index.js";
import type { runRuntimeCouncil } from "../runtime/council-service.js";
import { councilProgressLine, createTuiCouncil } from "./council-runner.js";
import type { TuiAction } from "./tui-action.js";

type Run = typeof runRuntimeCouncil;

const REPORT: CouncilReport = {
  question: "q",
  seats: [{ id: "a", spec: "a" }, { id: "b", spec: "b" }],
  answers: [
    { model: "a", text: "one", ms: 1 },
    { model: "b", text: "two", ms: 1 },
  ],
  judge: "a",
  summary: { agree: ["x"], disagree: [], unique: { a: [], b: [] }, parsed: true, raw: "" },
  chairman: { model: "a", text: "The final answer." },
  notes: [],
};

function setup(run: Run) {
  const actions: TuiAction[] = [];
  const council = createTuiCouncil({
    emit: (a) => actions.push(a),
    config: () => ({}) as AtomicAgentConfig,
    run,
  });
  const texts = () => actions.flatMap((a) => (a.type === "system_message" ? [a.text] : []));
  return { council, texts };
}

describe("createTuiCouncil (ATO-2432)", () => {
  it("shows the forecast, the stages and the verdict with the final answer on top", async () => {
    const run = vi.fn<Run>(async (request) => {
      request.onForecast?.("Up to 4 requests, at most $0.00", { calls: 4, maxUsd: 0, free: [], unpriced: [] });
      request.onProgress?.({ stage: "answered", seat: "a", ok: true, done: 2, total: 2 });
      request.onProgress?.({ stage: "chairman", chairman: "a" });
      return { ok: true, report: REPORT, forecast: { calls: 4, maxUsd: 0, free: [], unpriced: [] }, costLine: "", skipped: [] };
    });
    const { council, texts } = setup(run);
    await council.handle({ kind: "run", request: { question: "q", models: "a,b" } });
    expect(run.mock.calls[0]![0]).toMatchObject({ question: "q", models: "a,b" });
    const lines = texts();
    expect(lines[0]).toBe("council: q\nUp to 4 requests, at most $0.00. Asking now; nothing is saved to this chat.");
    expect(lines).toContain("council: 2 of 2 answered");
    expect(lines).toContain("council: a is writing the final answer");
    expect(lines[lines.length - 1]!.startsWith("== Final answer (chairman: a) ==\nThe final answer.")).toBe(true);
    expect(council.running).toBe(false);
  });

  it("runs one council at a time, and stop ends it without a verdict", async () => {
    let release: () => void = () => undefined;
    const run = vi.fn<Run>(
      (request) =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, report: REPORT, forecast: { calls: 1, maxUsd: 0, free: [], unpriced: [] }, costLine: "", skipped: [] });
          request.signal?.addEventListener("abort", () => release(), { once: true });
        }),
    );
    const { council, texts } = setup(run);
    const first = council.handle({ kind: "run", request: { question: "q" } });
    await council.handle({ kind: "run", request: { question: "again" } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(texts()).toContain("A council is already running; wait for it or type /council stop.");
    await council.handle({ kind: "stop" });
    await first;
    expect(texts()).toContain("Council stopped.");
    expect(texts().some((t) => t.startsWith("== Final answer"))).toBe(false);
  });

  it("says why it could not run", async () => {
    const run = vi.fn<Run>(async () => ({ ok: false, reason: "this council could cost up to $1.00, over the $0.10 limit; nothing was sent" }));
    const { council, texts } = setup(run);
    await council.handle({ kind: "run", request: { question: "q", maxUsd: 0.1 } });
    expect(texts()).toEqual(["Could not run the council: this council could cost up to $1.00, over the $0.10 limit; nothing was sent."]);
  });

  it("shows only the stage lines worth a line", () => {
    expect(councilProgressLine({ stage: "answered", seat: "a", ok: true, done: 1, total: 3 })).toBeNull();
    expect(councilProgressLine({ stage: "reviewing", judge: "a", rankers: 3 })).toBe(
      "council: a is comparing the answers; 3 members are ranking each other",
    );
  });
});
