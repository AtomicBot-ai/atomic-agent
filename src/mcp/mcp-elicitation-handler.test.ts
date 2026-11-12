import { describe, expect, it, vi } from "vitest";

import type { StructuredLogger } from "../tracing/structured-logger.js";

import {
  createMcpElicitationHandler,
  MAX_MESSAGE_CHARS,
  type McpElicitationPort,
  type McpElicitationQuestion,
  type McpElicitationReply,
} from "./mcp-elicitation-handler.js";

const PICK_ACCOUNT = {
  message: "Which account should I use?",
  requestedSchema: {
    type: "object",
    properties: {
      account: { type: "string", enum: ["work", "home"] },
      password: { type: "string" },
    },
    required: ["account"],
  },
};

type Ask = McpElicitationPort["ask"];

function portReplying(reply: McpElicitationReply | Ask) {
  const ask = vi.fn<Ask>(typeof reply === "function" ? reply : async () => reply);
  return { ask };
}

function fakeLogger(): StructuredLogger & { lines: string[] } {
  const lines: string[] = [];
  const record = (msg: string, ctx?: unknown) => lines.push(`${msg} ${JSON.stringify(ctx)}`);
  return { lines, info: record, warn: record, error: record, debug: record } as unknown as StructuredLogger & {
    lines: string[];
  };
}

const live = () => new AbortController().signal;

describe("createMcpElicitationHandler", () => {
  it("asks the port with the server name and the parsed fields, and returns an accepted answer", async () => {
    const port = portReplying({ action: "accept", content: { account: "home" } });
    const handler = createMcpElicitationHandler({ port, server: "gmail" });
    const res = await handler(PICK_ACCOUNT, live());
    expect(res).toEqual({ action: "accept", content: { account: "home" } });
    const question = port.ask.mock.calls[0][0] as McpElicitationQuestion;
    expect(question.server).toBe("gmail");
    expect(question.message).toBe("Which account should I use?");
    expect(question.fields.map((f) => f.name)).toEqual(["account", "password"]);
    expect(question.fields[1].sensitive).toBe(true);
  });

  it.each(["decline", "cancel"] as const)("passes the person's %s through", async (action) => {
    const handler = createMcpElicitationHandler({ port: portReplying({ action }), server: "s" });
    expect(await handler(PICK_ACCOUNT, live())).toEqual({ action });
  });

  it("declines when nobody can answer (no surface or an unattended run)", async () => {
    const handler = createMcpElicitationHandler({
      port: portReplying({ action: "unavailable", reason: "scheduled task" }),
      server: "s",
    });
    expect(await handler(PICK_ACCOUNT, live())).toEqual({ action: "decline" });
  });

  it("cancels on timeout and aborts the port's signal", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const port = portReplying((_q, signal) => {
        seen = signal;
        return new Promise<McpElicitationReply>(() => {});
      });
      const handler = createMcpElicitationHandler({ port, server: "s", timeoutMs: 1_000 });
      const pending = handler(PICK_ACCOUNT, live());
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await pending).toEqual({ action: "cancel" });
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels when the server cancels its request", async () => {
    const outer = new AbortController();
    const port = portReplying(() => new Promise<McpElicitationReply>(() => {}));
    const handler = createMcpElicitationHandler({ port, server: "s" });
    const pending = handler(PICK_ACCOUNT, outer.signal);
    outer.abort();
    expect(await pending).toEqual({ action: "cancel" });
  });

  it("declines, without asking, a schema that is not a flat form", async () => {
    const port = portReplying({ action: "accept", content: {} });
    const handler = createMcpElicitationHandler({ port, server: "s" });
    const res = await handler(
      {
        message: "x",
        requestedSchema: { type: "object", properties: { nested: { type: "object", properties: {} } } },
      },
      live(),
    );
    expect(res).toEqual({ action: "decline" });
    expect(port.ask).not.toHaveBeenCalled();
  });

  it("declines URL mode and malformed requests without asking", async () => {
    const port = portReplying({ action: "accept", content: {} });
    const handler = createMcpElicitationHandler({ port, server: "s" });
    expect(
      await handler({ mode: "url", message: "open", url: "https://x.test", elicitationId: "1" }, live()),
    ).toEqual({ action: "decline" });
    expect(await handler(null, live())).toEqual({ action: "decline" });
    expect(port.ask).not.toHaveBeenCalled();
  });

  it("cancels, instead of sending, an accepted answer that does not fit the schema", async () => {
    const handler = createMcpElicitationHandler({
      port: portReplying({ action: "accept", content: { account: "nobody" } }),
      server: "s",
    });
    expect(await handler(PICK_ACCOUNT, live())).toEqual({ action: "cancel" });
  });

  it("declines when the port throws or returns garbage", async () => {
    const throwing = createMcpElicitationHandler({
      port: portReplying(async () => {
        throw new Error("surface gone");
      }),
      server: "s",
    });
    expect(await throwing(PICK_ACCOUNT, live())).toEqual({ action: "decline" });
    const garbage = createMcpElicitationHandler({
      port: portReplying(async () => ({ action: "yes" }) as unknown as McpElicitationReply),
      server: "s",
    });
    expect(await garbage(PICK_ACCOUNT, live())).toEqual({ action: "decline" });
  });

  it("accepts an empty form as a confirmation", async () => {
    const handler = createMcpElicitationHandler({
      port: portReplying({ action: "accept", content: {} }),
      server: "s",
    });
    const res = await handler(
      { message: "Delete 3 files?", requestedSchema: { type: "object", properties: {} } },
      live(),
    );
    expect(res).toEqual({ action: "accept", content: {} });
  });

  it("clips a very long server message", async () => {
    const port = portReplying({ action: "decline" });
    const handler = createMcpElicitationHandler({ port, server: "s" });
    await handler({ ...PICK_ACCOUNT, message: "x".repeat(MAX_MESSAGE_CHARS * 2) }, live());
    const question = port.ask.mock.calls[0][0] as McpElicitationQuestion;
    expect(Array.from(question.message).length).toBe(MAX_MESSAGE_CHARS);
  });

  it("never logs the person's answer", async () => {
    const logger = fakeLogger();
    const handler = createMcpElicitationHandler({
      port: portReplying({ action: "accept", content: { account: "work", password: "hunter2-secret" } }),
      server: "s",
      logger,
    });
    const res = await handler(PICK_ACCOUNT, live());
    expect(res.action).toBe("accept");
    expect(logger.lines.length).toBeGreaterThan(0);
    expect(logger.lines.join("\n")).not.toContain("hunter2");
    expect(logger.lines.join("\n")).not.toContain("work");
  });
});
