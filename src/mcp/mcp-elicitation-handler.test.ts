import { describe, expect, it, vi } from "vitest";

import type { StructuredLogger } from "../tracing/structured-logger.js";

import {
  createMcpElicitationHandler,
  DEFAULT_ELICITATION_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  type McpElicitationPort,
  type McpElicitationQuestion,
  type McpElicitationReply,
  type McpElicitationSurface,
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

function portReplying(
  reply: McpElicitationReply | Ask,
  surface: McpElicitationPort["surface"] = "interactive",
) {
  const ask = vi.fn<Ask>(typeof reply === "function" ? reply : async () => reply);
  return { surface, ask };
}

/** A port that answers only after `afterMs` (run under fake timers). */
function portAnsweringAfter(afterMs: number, reply: McpElicitationReply, surface: McpElicitationSurface) {
  let seen: AbortSignal | undefined;
  const port = portReplying((_q, signal) => {
    seen = signal;
    return new Promise<McpElicitationReply>((resolve) => setTimeout(() => resolve(reply), afterMs));
  }, surface);
  return { port, signal: () => seen };
}

const MINUTE = 60_000;

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

  describe("how long it waits, by surface", () => {
    it("interactive: no cut-off, an answer after 10 minutes is accepted", async () => {
      vi.useFakeTimers();
      try {
        const { port, signal } = portAnsweringAfter(
          10 * MINUTE,
          { action: "accept", content: { account: "work" } },
          "interactive",
        );
        const handler = createMcpElicitationHandler({ port, server: "s" });
        let result: unknown;
        const pending = handler(PICK_ACCOUNT, live()).then((r) => (result = r));
        await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
        expect(result).toBeUndefined();
        expect(signal()?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(result).toEqual({ action: "accept", content: { account: "work" } });
      } finally {
        vi.useRealTimers();
      }
    });

    it("none (cron, headless, overnight): declines at once without asking", async () => {
      const port = portReplying({ action: "accept", content: { account: "work" } }, "none");
      const handler = createMcpElicitationHandler({ port, server: "s" });
      expect(await handler(PICK_ACCOUNT, live())).toEqual({ action: "decline" });
      expect(port.ask).not.toHaveBeenCalled();
    });

    it("remote-chat: declines after 5 minutes and takes the question down", async () => {
      vi.useFakeTimers();
      try {
        const { port, signal } = portAnsweringAfter(
          10 * MINUTE,
          { action: "accept", content: { account: "work" } },
          "remote-chat",
        );
        const handler = createMcpElicitationHandler({ port, server: "s" });
        let result: unknown;
        const pending = handler(PICK_ACCOUNT, live()).then((r) => (result = r));
        await vi.advanceTimersByTimeAsync(DEFAULT_ELICITATION_TIMEOUT_MS - 1);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(DEFAULT_ELICITATION_TIMEOUT_MS).toBe(5 * MINUTE);
        expect(result).toEqual({ action: "decline" });
        expect(signal()?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("remote-chat: an answer inside the window is used", async () => {
      vi.useFakeTimers();
      try {
        const { port } = portAnsweringAfter(
          4 * MINUTE,
          { action: "accept", content: { account: "home" } },
          "remote-chat",
        );
        const handler = createMcpElicitationHandler({ port, server: "s" });
        const pending = handler(PICK_ACCOUNT, live());
        await vi.advanceTimersByTimeAsync(4 * MINUTE);
        expect(await pending).toEqual({ action: "accept", content: { account: "home" } });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reads a surface function per request", async () => {
      let surface: McpElicitationSurface = "none";
      const port = portReplying({ action: "decline" }, () => surface);
      const handler = createMcpElicitationHandler({ port, server: "s" });
      await handler(PICK_ACCOUNT, live());
      expect(port.ask).not.toHaveBeenCalled();
      surface = "interactive";
      await handler(PICK_ACCOUNT, live());
      expect(port.ask).toHaveBeenCalledTimes(1);
    });

    it("treats a throwing or unknown surface as nobody there", async () => {
      const throwing = portReplying({ action: "accept", content: { account: "work" } }, () => {
        throw new Error("no idea");
      });
      expect(await createMcpElicitationHandler({ port: throwing, server: "s" })(PICK_ACCOUNT, live())).toEqual({
        action: "decline",
      });
      const unknown = portReplying(
        { action: "accept", content: { account: "work" } },
        "tv" as unknown as McpElicitationSurface,
      );
      expect(await createMcpElicitationHandler({ port: unknown, server: "s" })(PICK_ACCOUNT, live())).toEqual({
        action: "decline",
      });
      expect(throwing.ask).not.toHaveBeenCalled();
      expect(unknown.ask).not.toHaveBeenCalled();
    });
  });

  it("cancels an open-ended interactive wait when the server cancels its request", async () => {
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    const port = portReplying((_q, signal) => {
      seen = signal;
      return new Promise<McpElicitationReply>(() => {});
    }, "interactive");
    const handler = createMcpElicitationHandler({ port, server: "s" });
    const pending = handler(PICK_ACCOUNT, outer.signal);
    await Promise.resolve();
    outer.abort();
    expect(await pending).toEqual({ action: "cancel" });
    expect(seen?.aborted).toBe(true);
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
