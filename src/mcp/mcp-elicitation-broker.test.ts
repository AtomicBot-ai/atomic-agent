import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpElicitationBroker,
  type McpElicitationBrokerEvent,
  type McpElicitationPresenter,
} from "./mcp-elicitation-broker.js";
import { createMcpElicitationHandler } from "./mcp-elicitation-handler.js";
import type { McpElicitationQuestion } from "./mcp-elicitation-handler.js";

const CONFIRM: McpElicitationQuestion = {
  server: "demo",
  message: "Delete the draft?",
  fields: [],
};

const PICK: McpElicitationQuestion = {
  server: "demo",
  message: "Which account?",
  fields: [
    {
      name: "account",
      kind: "enum",
      required: true,
      sensitive: false,
      options: [
        { value: "work", label: "work" },
        { value: "home", label: "home" },
      ],
    },
  ],
};

function presenter(surface: McpElicitationPresenter["surface"] = "interactive") {
  const events: McpElicitationBrokerEvent[] = [];
  const p: McpElicitationPresenter = { surface, onEvent: (e) => events.push(e) };
  return { p, events };
}

function broker() {
  let n = 0;
  return new McpElicitationBroker({ newId: () => `q${++n}`, detachGraceMs: 1_000 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("McpElicitationBroker", () => {
  it("has surface none with nobody attached, so unattended runs are declined at once", async () => {
    const b = broker();
    expect(b.surface()).toBe("none");
    await expect(b.ask(CONFIRM, new AbortController().signal)).resolves.toEqual({
      action: "unavailable",
      reason: "no presenter attached",
    });
  });

  it("prefers a person at the screen over a chat bridge", () => {
    const b = broker();
    const remote = presenter("remote-chat");
    b.attach(remote.p);
    expect(b.surface()).toBe("remote-chat");
    const detach = b.attach(presenter("interactive").p);
    expect(b.surface()).toBe("interactive");
    detach();
    expect(b.surface()).toBe("remote-chat");
  });

  it("shows a plain confirm question and resolves with the person's accept", async () => {
    const b = broker();
    const { p, events } = presenter();
    b.attach(p);
    const reply = b.ask(CONFIRM, new AbortController().signal);
    expect(events[0]).toMatchObject({ type: "asked", request: { id: "q1", question: CONFIRM } });
    expect(b.answer("q1", { action: "accept" })).toEqual({ ok: true });
    await expect(reply).resolves.toEqual({ action: "accept", content: {} });
    expect(events[1]).toEqual({ type: "closed", id: "q1", action: "accept", reason: "answered" });
    expect(b.pending()).toEqual([]);
  });

  it("keeps the question open when the answer does not fit the form", async () => {
    const b = broker();
    b.attach(presenter().p);
    const reply = b.ask(PICK, new AbortController().signal);
    const bad = b.answer("q1", { action: "accept", content: { account: "other" } });
    expect(bad).toMatchObject({ ok: false, error: "invalid_answer" });
    expect(b.pending()).toHaveLength(1);
    expect(b.answer("q1", { action: "accept", content: { account: "home" } })).toEqual({ ok: true });
    await expect(reply).resolves.toEqual({ action: "accept", content: { account: "home" } });
  });

  it("refuses unknown actions and unknown ids", () => {
    const b = broker();
    b.attach(presenter().p);
    void b.ask(CONFIRM, new AbortController().signal);
    expect(b.answer("q1", { action: "unavailable" })).toEqual({ ok: false, error: "bad_action" });
    expect(b.answer("nope", { action: "decline" })).toEqual({ ok: false, error: "not_pending" });
  });

  it("closes the question when the server cancels", async () => {
    const b = broker();
    const { p, events } = presenter();
    b.attach(p);
    const ctl = new AbortController();
    const reply = b.ask(CONFIRM, ctl.signal);
    ctl.abort();
    await expect(reply).resolves.toEqual({ action: "cancel" });
    expect(events.at(-1)).toEqual({
      type: "closed",
      id: "q1",
      action: "cancel",
      reason: "server_cancelled",
    });
    expect(b.answer("q1", { action: "accept" })).toEqual({ ok: false, error: "not_pending" });
  });

  it("replays open questions to a presenter that attaches later", () => {
    const b = broker();
    const first = b.attach(presenter().p);
    void b.ask(CONFIRM, new AbortController().signal);
    first();
    const late = presenter();
    b.attach(late.p);
    expect(late.events).toEqual([
      { type: "asked", request: expect.objectContaining({ id: "q1" }) },
    ]);
  });

  it("answers unavailable when the last presenter stays away past the grace", async () => {
    vi.useFakeTimers();
    const b = broker();
    const detach = b.attach(presenter().p);
    const reply = b.ask(CONFIRM, new AbortController().signal);
    detach();
    await vi.advanceTimersByTimeAsync(999);
    expect(b.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(reply).resolves.toMatchObject({ action: "unavailable" });
  });

  it("keeps the question when a presenter comes back inside the grace", async () => {
    vi.useFakeTimers();
    const b = broker();
    const detach = b.attach(presenter().p);
    void b.ask(CONFIRM, new AbortController().signal);
    detach();
    await vi.advanceTimersByTimeAsync(500);
    b.attach(presenter().p);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.pending()).toHaveLength(1);
  });

  it("survives a presenter that throws", async () => {
    const b = broker();
    b.attach({ surface: "interactive", onEvent: () => { throw new Error("boom"); } });
    const ok = presenter();
    b.attach(ok.p);
    const reply = b.ask(CONFIRM, new AbortController().signal);
    expect(ok.events).toHaveLength(1);
    b.answer("q1", { action: "decline" });
    await expect(reply).resolves.toEqual({ action: "decline" });
  });

  it("never puts accepted content on a closed event", async () => {
    const b = broker();
    const { p, events } = presenter();
    b.attach(p);
    void b.ask(PICK, new AbortController().signal);
    b.answer("q1", { action: "accept", content: { account: "work" } });
    expect(JSON.stringify(events.at(-1))).not.toContain("work");
  });

  it("works as the handler's port end to end: decline at once with nobody, accept from a person", async () => {
    const b = broker();
    const handler = createMcpElicitationHandler({ port: b, server: "demo" });
    const params = { message: "Go?", requestedSchema: { type: "object", properties: {} } };
    await expect(handler(params, new AbortController().signal)).resolves.toEqual({
      action: "decline",
    });

    const { p, events } = presenter();
    b.attach(p);
    const pending = handler(params, new AbortController().signal);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const asked = events[0];
    if (asked?.type !== "asked") throw new Error("expected a question");
    b.answer(asked.request.id, { action: "accept" });
    await expect(pending).resolves.toEqual({ action: "accept", content: {} });
  });
});
