import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LinearApiError } from "./linear-api.js";
import { LINEAR_KEY_REFUSED, LinearPoller } from "./linear-poller.js";

const T0 = Date.parse("2026-11-27T10:00:00Z");

function comment(id: string, at: number) {
  return {
    id,
    body: "@agent hi",
    createdAt: new Date(at).toISOString(),
    user: { id: "u-owner" },
    issue: { id: "issue-1" },
  };
}

function api(pages: Array<Array<ReturnType<typeof comment>>>) {
  let i = 0;
  return {
    query: vi.fn(async () => ({ comments: { nodes: pages[Math.min(i++, pages.length - 1)], pageInfo: { hasNextPage: false } } })),
  };
}

const pollers: LinearPoller[] = [];
afterEach(async () => {
  for (const p of pollers.splice(0)) await p.close();
});

function make(over: Partial<ConstructorParameters<typeof LinearPoller>[0]> & { api: { query: (...a: never[]) => Promise<unknown> } }) {
  const dir = mkdtempSync(join(tmpdir(), "linear-poll-"));
  const onEvent = vi.fn();
  const poller = new LinearPoller({
    intervalMs: 60_000,
    cursorPath: join(dir, "linear-poll-cursor.json"),
    onEvent,
    assignee: () => null,
    onFatal: vi.fn(),
    logger: { warn: vi.fn() },
    now: () => T0,
    ...over,
  } as never);
  pollers.push(poller);
  return { poller, onEvent, cursorPath: join(dir, "linear-poll-cursor.json") };
}

describe("LinearPoller", () => {
  it("does not answer comments written before the first start, but answers later ones once each", async () => {
    const fake = api([[comment("old", T0 - 30_000)], [comment("old", T0 - 30_000), comment("new", T0 + 5_000)]]);
    const { poller, onEvent } = make({ api: fake });
    await poller.listen();
    expect(onEvent).not.toHaveBeenCalled();
    await poller.pollOnce();
    await poller.pollOnce();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![1]).toBe("poll:comment:new");
  });

  it("asks from a minute before the saved cursor and saves the newest time it saw", async () => {
    const fake = api([[comment("c1", T0 + 10_000)]]);
    const { poller, cursorPath } = make({ api: fake });
    writeFileSync(cursorPath, JSON.stringify({ version: 1, since: T0, handled: [] }));
    await poller.listen();
    expect(fake.query.mock.calls[0]![1]).toMatchObject({ since: new Date(T0 - 60_000).toISOString() });
    const saved = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(saved.since).toBe(T0 + 10_000);
    expect(saved.handled).toContain("comment:c1");
  });

  it("does not replay an event already handled before a restart", async () => {
    const fake = api([[comment("c1", T0 + 10_000)]]);
    const first = make({ api: fake });
    writeFileSync(first.cursorPath, JSON.stringify({ version: 1, since: T0, handled: [] }));
    await first.poller.listen();
    expect(first.onEvent).toHaveBeenCalledTimes(1);
    const again = make({ api: fake, cursorPath: first.cursorPath });
    await again.poller.listen();
    expect(again.onEvent).not.toHaveBeenCalled();
  });

  it("looks back at most 24 hours after a long stop", async () => {
    const fake = api([[]]);
    const { poller, cursorPath } = make({ api: fake });
    writeFileSync(cursorPath, JSON.stringify({ version: 1, since: T0 - 10 * 24 * 3600_000, handled: [] }));
    await poller.listen();
    expect(fake.query.mock.calls[0]![1]).toMatchObject({ since: new Date(T0 - 24 * 3600_000 - 60_000).toISOString() });
  });

  it("rejects listen when Linear refuses the key, and reports a later refusal as fatal", async () => {
    const refused = { query: vi.fn(async () => Promise.reject(new LinearApiError("no", "auth"))) };
    const { poller } = make({ api: refused });
    await expect(poller.listen()).rejects.toThrow(LINEAR_KEY_REFUSED);
  });

  it("keeps polling through a network error", async () => {
    const flaky = { query: vi.fn(async () => Promise.reject(new Error("fetch failed"))) };
    const { poller } = make({ api: flaky });
    await expect(poller.listen()).resolves.toBeUndefined();
  });

  it("asks for assignments only when the channel gives an assignee", async () => {
    const query = vi.fn(async (q: string) => (q.includes("RecentAssignments") ? { issues: { nodes: [] } } : { comments: { nodes: [] } }));
    const { poller } = make({ api: { query }, assignee: () => "u-bot" });
    await poller.listen();
    expect(query.mock.calls.some((c) => String(c[0]).includes("RecentAssignments"))).toBe(true);
  });
});
