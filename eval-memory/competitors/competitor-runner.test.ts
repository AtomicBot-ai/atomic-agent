import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { runCompetitorScenario } from "./competitor-runner.js";
import type {
  CompetitorAdapter,
  CompetitorRecallRequest,
  CompetitorTurn,
} from "./competitor-adapter.js";

class StubAdapter implements CompetitorAdapter {
  readonly name = "stub";
  readonly label = "Stub adapter";
  public ingested: CompetitorTurn[] = [];
  public recallCalls: CompetitorRecallRequest[] = [];
  public resetCalls: string[] = [];

  constructor(private readonly recallText: string = "stub memory") {}

  async ensureSession(): Promise<void> {}
  async ingest(turn: CompetitorTurn) {
    this.ingested.push(turn);
    return { durationMs: 1 };
  }
  async recall(req: CompetitorRecallRequest) {
    this.recallCalls.push(req);
    return {
      durationMs: 2,
      items: [{ id: "m1", text: this.recallText, score: 0.9 }],
    };
  }
  async reset(sessionId: string) {
    this.resetCalls.push(sessionId);
  }
  async close(): Promise<void> {}
}

describe("runCompetitorScenario", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Paris" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("resets the session before ingesting and ingests every turn in order", async () => {
    const adapter = new StubAdapter();
    const result = await runCompetitorScenario(adapter, {
      scenarioId: "s1",
      haystack: [
        { sessionId: "s1", turnId: "t1", speaker: "user", text: "Hello" },
        { sessionId: "s1", turnId: "t2", speaker: "assistant", text: "Hi" },
      ],
      questions: [
        { id: "q1", text: "Capital of France?", gold: ["Paris"] },
      ],
      recallK: 3,
      llamaUrl: "http://localhost:19091",
    });

    expect(adapter.resetCalls).toEqual(["s1"]);
    expect(adapter.ingested.map((t) => t.turnId)).toEqual(["t1", "t2"]);
    expect(result.adapterName).toBe("stub");
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].substringMatch).toBe(true);
    expect(result.outcomes[0].retrievedCount).toBe(1);
  });

  it("returns null substringMatch when no gold is provided", async () => {
    const adapter = new StubAdapter();
    const result = await runCompetitorScenario(adapter, {
      scenarioId: "s1",
      haystack: [],
      questions: [{ id: "q1", text: "Free-form?" }],
      recallK: 1,
      llamaUrl: "http://localhost:19091",
    });
    expect(result.outcomes[0].substringMatch).toBeNull();
  });

  it("forwards recallK to the adapter and reports retrievedCount", async () => {
    const adapter = new StubAdapter();
    await runCompetitorScenario(adapter, {
      scenarioId: "s1",
      haystack: [],
      questions: [{ id: "q1", text: "?" }],
      recallK: 7,
      llamaUrl: "http://localhost:19091",
    });
    expect(adapter.recallCalls[0].k).toBe(7);
  });
});
