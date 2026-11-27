import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/index.js";
import type { CompletionRequest, CompletionResult } from "../llm/provider/completion-types.js";
import { fakeProvider } from "../llm/provider/fake-provider.fixture.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";

import type { BuiltSpecs } from "./models-bench-providers.js";
import { councilQuestionOf, runModelsCouncil } from "./models-council-command.js";

const CONFIG = {
  llm: {
    activeTextProvider: "or",
    activeEmbeddingProvider: "or",
    providers: [{ id: "or", kind: "openrouter" }],
    toolTransport: "auto",
  },
} as unknown as AtomicAgentConfig;

const JUDGE_REPLY = [
  "## Agree",
  "- SQL is fine",
  "## Disagree",
  "- A says Postgres, B says SQLite",
  "## Unique",
  "### Answer A",
  "- replication",
  "### Answer B",
  "- none",
].join("\n");

function result(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: null,
  };
}

const isJudgePrompt = (r: CompletionRequest) => String(r.prompt).includes("judge of a model council");

/** A model that answers `answer` and, when asked to judge, `judgeReply`. */
function model(answer: string, seen: CompletionRequest[], judgeReply: string | Error = JUDGE_REPLY): LlmProvider {
  return fakeProvider("p", "native_tools", async (request) => {
    seen.push(request);
    if (isJudgePrompt(request)) {
      if (judgeReply instanceof Error) throw judgeReply;
      return result(judgeReply);
    }
    return result(answer);
  });
}

function harness(providers: Record<string, LlmProvider>, refused: BuiltSpecs["refused"] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[][] = [];
  return {
    out,
    err,
    asked,
    deps: {
      config: CONFIG,
      build: async (_config: AtomicAgentConfig, specs: ReadonlyArray<{ spec: string }>) => {
        asked.push(specs.map((s) => s.spec));
        const map = new Map(Object.entries(providers).filter(([spec]) => specs.some((s) => s.spec === spec)));
        return { providers: map, refused };
      },
      write: (t: string) => out.push(t),
      writeErr: (t: string) => err.push(t),
    },
  };
}

describe("models council (ATO-2232)", () => {
  it("asks every model, then the first listed judges and the summary is printed under model names", async () => {
    const seenA: CompletionRequest[] = [];
    const seenB: CompletionRequest[] = [];
    const h = harness({ "or:a": model("Postgres", seenA), "or:b": model("SQLite", seenB) });
    const code = await runModelsCouncil(["which", "db?", "--models", "or:a,or:b"], h.deps);
    expect(code).toBe(0);
    expect(h.asked).toEqual([["or:a", "or:b"]]);
    // Answer, judge, then the chairman (the judge by default, ATO-2432); two answers are too few to rank.
    expect(seenA.map((r) => isJudgePrompt(r))).toEqual([false, true, false]);
    expect(String(seenA[2]!.prompt)).toContain("chairman of a model council");
    expect(seenB.map((r) => isJudgePrompt(r))).toEqual([false]);
    expect(seenA[0]!.prompt).toBe("which db?");
    const judgePrompt = String(seenA[1]!.prompt);
    expect(judgePrompt).toContain("### Answer A\nPostgres");
    expect(judgePrompt).toContain("### Answer B\nSQLite");
    expect(judgePrompt).not.toContain("or:b");
    const text = h.out.join("");
    expect(text).toMatch(/== or:a \(\d+ ms\) ==\nPostgres\n\n== or:b \(\d+ ms\) ==\nSQLite\n/);
    expect(text).toContain("== Council summary (judge: or:a) ==");
    expect(text).toContain("Disagree\n  - A says Postgres, B says SQLite");
    expect(text).toContain("  or:a\n    - replication\n  or:b\n    (nothing)");
  });

  it("builds a --judge outside --models and lets it judge without answering", async () => {
    const seenJudge: CompletionRequest[] = [];
    const h = harness({
      "or:a": model("Postgres", []),
      "or:b": model("SQLite", []),
      "or:j": model("unused", seenJudge),
    });
    const code = await runModelsCouncil(["which db?", "--models", "or:a,or:b", "--judge", "or:j", "--json"], h.deps);
    expect(code).toBe(0);
    expect(h.asked).toEqual([["or:a", "or:b", "or:j"]]);
    // It judges, then chairs (the chairman defaults to the judge, ATO-2432); it never answers.
    expect(seenJudge).toHaveLength(2);
    expect(isJudgePrompt(seenJudge[0]!)).toBe(true);
    expect(String(seenJudge[1]!.prompt)).toContain("chairman of a model council");
    const report = JSON.parse(h.out.join(""));
    expect(report.judge).toBe("or:j");
    expect(report.answers.map((a: { model: string }) => a.model)).toEqual(["or:a", "or:b"]);
    expect(report.summary).toMatchObject({ agree: ["SQL is fine"], unique: { "or:a": ["replication"], "or:b": [] } });
  });

  it("is reached through models ask --council: the flag is not part of the question", () => {
    expect(councilQuestionOf(["--council", "which", "--judge", "or:j", "db?", "--models", "a,b", "--json"])).toBe(
      "which db?",
    );
  });

  it("skips the judge when only one model answered", async () => {
    const seenA: CompletionRequest[] = [];
    const down = fakeProvider("p", "native_tools", async () => {
      throw new Error("401");
    });
    const h = harness({ "or:a": model("Postgres", seenA), "or:b": down });
    const code = await runModelsCouncil(["q", "--models", "or:a,or:b"], h.deps);
    expect(code).toBe(0);
    expect(seenA).toHaveLength(1);
    expect(h.err.join("")).toContain("only one answer; nothing to compare");
    expect(h.out.join("")).not.toContain("Council summary");
  });

  it("prints the answers and exits 1 when the judge fails", async () => {
    const h = harness({ "or:a": model("Postgres", [], new Error("rate limited")), "or:b": model("SQLite", []) });
    const code = await runModelsCouncil(["q", "--models", "or:a,or:b"], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("")).toContain("judge or:a failed: rate limited");
    expect(h.out.join("")).toContain("SQLite");
  });

  it("needs a question", async () => {
    const h = harness({});
    expect(await runModelsCouncil(["--models", "or:a,or:b"], h.deps)).toBe(2);
    expect(h.asked).toEqual([]);
  });

  it("prints the chairman's final answer first, then the summary (ATO-2432)", async () => {
    const h = harness({ "or:a": model("Postgres", []), "or:b": model("SQLite", []) });
    expect(await runModelsCouncil(["q", "--models", "or:a,or:b"], h.deps)).toBe(0);
    const text = h.out.join("");
    expect(text.indexOf("== Final answer (chairman: or:a) ==")).toBe(0);
    expect(text.indexOf("== Council summary")).toBeGreaterThan(0);
    expect(h.err.join("")).toMatch(/^Up to 4 requests, at most \$/);
  });

  it("--dry-run prints the forecast and asks nobody; --no-chairman skips the last stage", async () => {
    const seen: CompletionRequest[] = [];
    const h = harness({ "or:a": model("Postgres", seen), "or:b": model("SQLite", []) });
    expect(await runModelsCouncil(["q", "--models", "or:a,or:b", "--dry-run"], h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(seen).toEqual([]);
    expect(await runModelsCouncil(["q", "--models", "or:a,or:b", "--no-chairman"], h.deps)).toBe(0);
    expect(seen.map((r) => isJudgePrompt(r))).toEqual([false, true]);
  });

  it("refuses a bad --max-usd as a usage error", async () => {
    const h = harness({});
    expect(await runModelsCouncil(["q", "--max-usd", "lots"], h.deps)).toBe(2);
  });

  it("exits 1 when no model could be built", async () => {
    const h = harness({}, [{ spec: "nope", reason: "no provider" }]);
    expect(await runModelsCouncil(["q", "--models", "nope"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("skipped nope: no provider");
  });
});
