import { describe, expect, it } from "vitest";

import { buildChairmanPrompt } from "./council-chairman.js";
import { formatCouncilReport } from "./council-format.js";
import { parseCouncilSeats, type CouncilSeat } from "./council-seats.js";
import {
  COUNCIL_ANSWER_MAX_TOKENS,
  councilAnswerBudget,
  runCouncil,
  type CouncilCall,
  type CouncilProgress,
} from "./run-council.js";

const JUDGE_REPLY = "## Agree\n- SQL works\n## Disagree\n- A says Postgres, B says SQLite\n## Unique\n- none";

const isJudge = (p: string) => p.includes("judge of a model council");
const isRanker = (p: string) => p.includes("reviewer on a model council");
const isChairman = (p: string) => p.includes("chairman of a model council");

function seats(raw: string): CouncilSeat[] {
  const parsed = parseCouncilSeats(raw, "x");
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.seats;
}

/** A council where `answers[spec]` answers and every model ranks "Answer B" first. */
function fakeComplete(answers: Record<string, string | Error>, calls: CouncilCall[]) {
  return async (call: CouncilCall): Promise<string> => {
    calls.push(call);
    if (isJudge(call.prompt)) return JUDGE_REPLY;
    if (isRanker(call.prompt)) return "FINAL RANKING:\n1. Answer B\n2. Answer A";
    if (isChairman(call.prompt)) return "Final: SQLite for a desktop app.";
    const answer = answers[call.spec];
    if (answer instanceof Error) throw answer;
    return answer ?? "";
  };
}

describe("runCouncil (ATO-2432)", () => {
  it("answers, then judges and ranks, then the chairman writes the final answer", async () => {
    const calls: CouncilCall[] = [];
    const progress: CouncilProgress[] = [];
    const report = await runCouncil({
      question: "Which db?",
      seats: seats("or:a,or:b,or:c"),
      complete: fakeComplete({ "or:a": "Postgres", "or:b": "SQLite", "or:c": "DuckDB" }, calls),
      onProgress: (e) => progress.push(e),
    });
    expect(report.answers.map((a) => a.text)).toEqual(["Postgres", "SQLite", "DuckDB"]);
    expect(report.summary?.disagree).toEqual(["A says Postgres, B says SQLite"]);
    // or:a sees B,C as A,B and ranks "B" (or:c) first; or:b sees A,C -> or:c; or:c sees A,B -> or:b.
    expect(report.rankings?.map((r) => r.order)).toEqual([
      ["or:c", "or:b"],
      ["or:c", "or:a"],
      ["or:b", "or:a"],
    ]);
    expect(report.standings?.[0]).toEqual({ model: "or:c", averageRank: 1, votes: 2 });
    expect(report.chairman).toEqual({ model: "or:a", text: "Final: SQLite for a desktop app." });
    const chairmanCall = calls.find((c) => isChairman(c.prompt))!;
    expect(chairmanCall.spec).toBe("or:a");
    expect(chairmanCall.prompt).toContain("## Peer ranking");
    expect(chairmanCall.prompt).toContain("## Where they disagree\n- A says Postgres, B says SQLite");
    expect(chairmanCall.prompt).not.toContain("or:b");
    expect(calls.filter((c) => !isJudge(c.prompt) && !isRanker(c.prompt) && !isChairman(c.prompt)).every((c) => c.maxTokens === COUNCIL_ANSWER_MAX_TOKENS)).toBe(true);
    expect(progress.map((p) => p.stage)).toEqual(["answering", "answered", "answered", "answered", "reviewing", "chairman", "done"]);
    expect(report.notes).toEqual([]);
  });

  it("asks a repeated model once per seat at its own temperature", async () => {
    const calls: CouncilCall[] = [];
    await runCouncil({
      question: "q",
      seats: seats("or:a*3"),
      rank: false,
      chairman: null,
      complete: fakeComplete({ "or:a": "x" }, calls),
    });
    const answerCalls = calls.filter((c) => !isJudge(c.prompt));
    expect(answerCalls.map((c) => c.temperature)).toEqual([undefined, 0.7, 1.0]);
  });

  it("skips the ranking under three answers and says so", async () => {
    const calls: CouncilCall[] = [];
    const report = await runCouncil({
      question: "q",
      seats: seats("or:a,or:b"),
      complete: fakeComplete({ "or:a": "Postgres", "or:b": "SQLite" }, calls),
    });
    expect(calls.some((c) => isRanker(c.prompt))).toBe(false);
    expect(report.rankings).toBeUndefined();
    expect(report.notes).toEqual(["ranking needs 3 answers; skipped"]);
    expect(report.chairman?.text).toBeDefined();
  });

  it("stops after the answers when only one model answered", async () => {
    const calls: CouncilCall[] = [];
    const report = await runCouncil({
      question: "q",
      seats: seats("or:a,or:b"),
      complete: fakeComplete({ "or:a": "Postgres", "or:b": new Error("401") }, calls),
    });
    expect(calls).toHaveLength(2);
    expect(report.answers[1]!.error).toBe("401");
    expect(report.notes).toEqual(["only one answer; nothing to compare"]);
    expect(report.chairman).toBeUndefined();
  });

  it("keeps the summary and ranking when the chairman fails", async () => {
    const calls: CouncilCall[] = [];
    const base = fakeComplete({ "or:a": "1", "or:b": "2", "or:c": "3" }, calls);
    const report = await runCouncil({
      question: "q",
      seats: seats("or:a,or:b,or:c"),
      chairman: "or:boss",
      complete: async (call) => {
        if (call.spec === "or:boss") throw new Error("rate limited");
        return base(call);
      },
    });
    expect(report.chairman).toEqual({ model: "or:boss", error: "rate limited" });
    expect(report.summary).toBeDefined();
    expect(report.standings).toHaveLength(3);
  });

  it("returns cancelled without the later stages once the signal aborts", async () => {
    const controller = new AbortController();
    const calls: CouncilCall[] = [];
    const report = await runCouncil({
      question: "q",
      seats: seats("or:a,or:b"),
      signal: controller.signal,
      complete: async (call) => {
        calls.push(call);
        controller.abort();
        return "x";
      },
    });
    expect(report.cancelled).toBe(true);
    expect(calls).toHaveLength(2);
    expect(report.summary).toBeUndefined();
  });

  it("cuts each quoted answer so a prompt fits a request bound", () => {
    expect(councilAnswerBudget("q", 3)).toBe(12_000);
    expect(councilAnswerBudget("q", 4, 16_000)).toBe(Math.floor((16_000 - 1 - 1_500) / 4));
    expect(councilAnswerBudget("q", 8, 2_000)).toBe(500);
  });
});

describe("buildChairmanPrompt / formatCouncilReport", () => {
  it("writes the verdict first: final answer, summary, ranking, then the answers", async () => {
    const report = await runCouncil({
      question: "Which db?",
      seats: seats("or:a,or:b,or:c"),
      complete: fakeComplete({ "or:a": "Postgres", "or:b": "SQLite", "or:c": "DuckDB" }, []),
    });
    const text = formatCouncilReport(report);
    const order = ["== Final answer (chairman: or:a) ==", "== Council summary (judge: or:a) ==", "== Peer ranking", "== or:a ("];
    const at = order.map((h) => text.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("1. or:c  average place 1.0 from 2 reviews");
  });

  it("names no model in the chairman prompt", () => {
    const prompt = buildChairmanPrompt({
      question: "q",
      members: [
        { label: "A", model: "secret-model", text: "one" },
        { label: "B", model: "other-model", text: "two" },
      ],
      standings: [{ model: "other-model", averageRank: 1, votes: 1 }],
    });
    expect(prompt).not.toContain("secret-model");
    expect(prompt).not.toContain("other-model");
    expect(prompt).toContain("1. Answer B: average place 1.0");
  });
});
