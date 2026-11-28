import { describe, expect, it, vi } from "vitest";

import { handleLinearEvent, type LinearInboundContext } from "./linear-inbound-handler.js";
import { LinearOwnComments } from "./linear-own-comments.js";
import { commentEvent, pollAssignments, pollComments } from "./linear-poll-queries.js";
import { LinearTurnQueue } from "./linear-turn-queue.js";

const node = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  body: "@agent look",
  createdAt: "2026-11-27T10:00:00.000Z",
  url: "https://linear.app/acme/issue/ENG-7#comment-c1",
  parent: null,
  user: { id: "u-owner", name: "Nadia" },
  botActor: null,
  issue: { id: "issue-7", identifier: "ENG-7", title: "Login breaks", url: "https://linear.app/acme/issue/ENG-7" },
  ...over,
});

describe("commentEvent", () => {
  it("maps a polled comment to the payload a webhook would deliver", () => {
    const event = commentEvent(node({ parent: { id: "c-root" } }));
    expect(event?.key).toBe("comment:c1");
    expect(event?.payload).toMatchObject({
      type: "Comment",
      action: "create",
      actor: { id: "u-owner", name: "Nadia" },
      data: { id: "c1", body: "@agent look", issueId: "issue-7", userId: "u-owner", parentId: "c-root", issue: { identifier: "ENG-7" } },
    });
    expect((event?.payload.data as Record<string, unknown>).botActor).toBeUndefined();
  });

  it("keeps botActor so app comments stay ignored, and skips comments outside an issue", () => {
    expect((commentEvent(node({ botActor: { id: "b" } }))?.payload.data as Record<string, unknown>).botActor).toEqual({ id: "b" });
    expect(commentEvent(node({ issue: null }))).toBeNull();
  });

  it("a polled mention runs a turn through the same handler as a webhook", async () => {
    const runTurn = vi.fn(async () => ({}));
    const ctx = {
      runtime: { runTurn, createSession: vi.fn(() => ({ id: "s1" })), sessionStore: { load: () => null } },
      post: vi.fn(async () => {}),
      sessions: { get: () => ({ current: null }), setCurrent: vi.fn(), rotate: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ownerIds: ["u-owner"],
      handles: ["agent"],
      viewerId: "u-bot",
      onAssign: false,
      own: new LinearOwnComments(),
      bridge: null,
      turns: new LinearTurnQueue(),
      seen: new Set<string>(),
    } as unknown as LinearInboundContext;
    await handleLinearEvent(commentEvent(node())!.payload, ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});

describe("pollComments", () => {
  it("follows pages, passes the cursor, and returns oldest first", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        comments: { nodes: [node({ id: "c3", createdAt: "2026-11-27T10:03:00Z" })], pageInfo: { hasNextPage: true, endCursor: "p2" } },
      })
      .mockResolvedValueOnce({
        comments: { nodes: [node({ id: "c2", createdAt: "2026-11-27T10:02:00Z" })], pageInfo: { hasNextPage: false } },
      });
    const events = await pollComments({ query }, "2026-11-27T10:00:00.000Z");
    expect(events.map((e) => e.key)).toEqual(["comment:c2", "comment:c3"]);
    expect(query.mock.calls[0]![1]).toEqual({ since: "2026-11-27T10:00:00.000Z", after: null });
    expect(query.mock.calls[1]![1]).toEqual({ since: "2026-11-27T10:00:00.000Z", after: "p2" });
  });
});

describe("pollAssignments", () => {
  it("turns each assignment to the viewer after the cursor into an Issue update with actor and previous assignee", async () => {
    const query = vi.fn().mockResolvedValue({
      issues: {
        nodes: [
          {
            id: "issue-3",
            identifier: "ENG-3",
            title: "Add dark mode",
            description: "Both themes.",
            history: {
              nodes: [
                { createdAt: "2026-11-27T09:00:00Z", actorId: "u-owner", fromAssigneeId: null, toAssigneeId: "u-bot" },
                { createdAt: "2026-11-27T10:05:00Z", actorId: "u-owner", fromAssigneeId: "u-x", toAssigneeId: "u-bot" },
                { createdAt: "2026-11-27T10:06:00Z", actorId: "u-owner", fromAssigneeId: "u-bot", toAssigneeId: "u-y" },
              ],
            },
          },
        ],
      },
    });
    const events = await pollAssignments({ query }, "u-bot", "2026-11-27T10:00:00.000Z");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      type: "Issue",
      action: "update",
      actor: { id: "u-owner" },
      updatedFrom: { assigneeId: "u-x" },
      data: { id: "issue-3", assigneeId: "u-bot", identifier: "ENG-3", title: "Add dark mode" },
    });
  });
});
