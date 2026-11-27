import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AutofixStore,
  GithubApi,
  autofixKey,
  enableAutofix,
  startWatch,
} from "../../github/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimePrAutofixWatcher } from "./runtime-pr-autofix-watcher.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** PR #42 with a red lint job and nothing else. */
const redPr = () =>
  new GithubApi({
    token: "ghp_test",
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/42")) {
        return json({ number: 42, state: "open", head: { ref: "feat/x", sha: "sha1", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } });
      }
      if (url.includes("/check-runs")) return json({ total_count: 1, check_runs: [{ id: 1, name: "lint", status: "completed", conclusion: "failure" }] });
      if (url.includes("/status?")) return json({ total_count: 0, statuses: [] });
      return json([]);
    }) as typeof fetch,
  });

describe("createRuntimePrAutofixWatcher (ATO-2516)", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "runtime-autofix-watch-"));
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const logger = new StructuredLogger({ level: "error", sinks: [] });
  const config = (enabled: boolean) => ({
    paths: { stateDir } as never,
    tasks: { enabled } as never,
  });

  it("is not built while tasks are off", () => {
    const sidecar = createRuntimePrAutofixWatcher({
      config: config(false),
      taskRunner: { create: () => { throw new Error("no"); } },
      taskStore: { get: () => null },
      logger,
    });
    expect(sidecar).toBeNull();
  });

  it("files a round as a one-attempt scheduler task in the watching chat", async () => {
    const state = enableAutofix("feat/x", 3, new Date("2026-11-27T12:00:00Z"));
    await new AutofixStore(stateDir).set(autofixKey("acme/widgets", 42), {
      ...state,
      watch: startWatch({ sessionId: "chat-1", notify: "push", everyMinutes: 10 }, new Date("2026-11-27T12:00:00Z")),
    });
    const created: Array<Record<string, unknown>> = [];
    const sidecar = createRuntimePrAutofixWatcher({
      config: config(true),
      taskRunner: {
        create: (input) => {
          created.push(input as unknown as Record<string, unknown>);
          return { id: "t1" } as never;
        },
      },
      taskStore: { get: () => null },
      logger,
      client: redPr,
    });
    await sidecar!.tick(Date.parse("2026-11-27T12:01:00Z"), new AbortController().signal);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      sessionId: "chat-1",
      origin: "scheduler",
      triggerSource: "scheduler",
      maxAttempts: 1,
      notify: "push",
    });
  });
});
