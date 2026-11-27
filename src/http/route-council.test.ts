import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/index.js";
import type { PlainCompleteInput } from "../runtime/plain-complete.js";
import { createCouncilHandler, parseCouncilBody } from "./route-council.js";
import type { HandlerContext } from "./request-context.js";

const CONFIG = {
  localModels: { url: "http://127.0.0.1:8080" },
  llm: {
    activeTextProvider: "local",
    activeEmbeddingProvider: "local",
    providers: [{ id: "local", kind: "llama-server" }],
    toolTransport: "auto",
  },
} as unknown as AtomicAgentConfig;

const JUDGE = "## Agree\n- yes\n## Disagree\n- none\n## Unique\n- none";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function start(completePlain?: (input: PlainCompleteInput) => Promise<{ ok: true; text: string }>): Promise<string> {
  const handler = createCouncilHandler({ config: () => CONFIG });
  const ctx = { runtime: completePlain ? { completePlain } : {}, params: {} } as unknown as HandlerContext;
  server = createServer((req, res) => void handler(req, res, ctx));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/council`;
}

/** `event:` / `data:` frames of an SSE body, keepalive comments skipped. */
function frames(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split("\n\n")
    .filter((f) => f.startsWith("event:"))
    .map((f) => {
      const [eventLine, dataLine] = f.split("\n");
      return { event: eventLine!.slice("event: ".length), data: JSON.parse(dataLine!.slice("data: ".length)) };
    });
}

describe("parseCouncilBody (ATO-2432)", () => {
  it("maps the body to a council request", () => {
    expect(parseCouncilBody({ question: " q ", models: "a,b*2", chairman: null, rank: false, max_usd: 0.5 })).toEqual({
      question: "q",
      models: "a,b*2",
      chairman: null,
      rank: false,
      maxUsd: 0.5,
    });
  });

  it("names the bad field", () => {
    expect(parseCouncilBody({ question: "" })).toMatchObject({ param: "question" });
    expect(parseCouncilBody({ question: "q", rank: "no" })).toMatchObject({ param: "rank" });
    expect(parseCouncilBody({ question: "q", max_usd: -1 })).toMatchObject({ param: "max_usd" });
    expect(parseCouncilBody([])).toEqual({ message: "body must be a JSON object" });
  });
});

describe("POST /api/council", () => {
  it("answers a dry run with the forecast and sends nothing", async () => {
    const asked: PlainCompleteInput[] = [];
    const url = await start(async (input) => {
      asked.push(input);
      return { ok: true, text: "x" };
    });
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ question: "q", dry_run: true }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cost_line: string };
    expect(json.cost_line).toMatch(/^Up to \d+ requests, at most \$0\.00 \(free: local\)$/);
    expect(asked).toEqual([]);
  });

  it("streams the forecast, the stages and one result", async () => {
    const url = await start(async (input) => ({
      ok: true,
      text: input.prompt.includes("judge of a model council")
        ? JUDGE
        : input.prompt.includes("reviewer on a model council")
          ? "FINAL RANKING:\n1. Answer A\n2. Answer B"
          : input.prompt.includes("chairman of a model council")
            ? "The final answer."
            : "an answer",
    }));
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ question: "q" }) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const list = frames(await res.text());
    expect(list[0]!.event).toBe("forecast");
    expect(list.some((f) => f.event === "progress" && f.data.stage === "chairman")).toBe(true);
    const last = list[list.length - 1]!;
    expect(last.event).toBe("result");
    const report = last.data.report as { chairman: { text: string }; standings: unknown[] };
    expect(report.chairman.text).toBe("The final answer.");
    expect(report.standings).toHaveLength(3);
  });

  it("ends with an error frame when no seat can be used", async () => {
    const url = await start();
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ question: "q" }) });
    const list = frames(await res.text());
    expect(list[list.length - 1]).toMatchObject({ event: "error" });
  });

  it("refuses a bad body with 400 before any stream", async () => {
    const url = await start();
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ question: 3 }) });
    expect(res.status).toBe(400);
  });
});
