import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatSessionMap } from "../chat-session-map.js";
import { SignalApprovalBridge } from "./signal-approval-bridge.js";
import { handleSignalEnvelope, type SignalInboundContext } from "./signal-inbound-handler.js";
import type { SignalTarget } from "./signal-rpc.js";
import type { SignalEnvelope } from "./signal-types.js";

const OWNER = "+15550002222";
const BOT = "+15550001111";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dm(text: string, from = OWNER): SignalEnvelope {
  return { source: from, sourceNumber: from, sourceName: "Ada", dataMessage: { message: text } };
}

function makeCtx(over: Partial<SignalInboundContext> = {}, replyText = "done") {
  const dir = mkdtempSync(join(tmpdir(), "signal-inbound-"));
  dirs.push(dir);
  const sent: Array<{ target: SignalTarget; text: string }> = [];
  const sessions = new Map<string, { id: string; metadata: Record<string, unknown> }>();
  let n = 0;
  const runTurn = vi.fn(async (_session: unknown, _prompt: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: replyText } });
    return {};
  });
  const runtime = {
    runTurn,
    sessionStore: { load: (id: string) => sessions.get(id) ?? null },
    createSession: (input: { metadata: Record<string, unknown> }) => {
      const s = { id: `s-${++n}`, metadata: input.metadata };
      sessions.set(s.id, s);
      return s;
    },
    turnController: { isBusy: () => false },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const send = async (target: SignalTarget, text: string) => {
    sent.push({ target, text });
  };
  const bridge = new SignalApprovalBridge({
    send,
    approvals: { resolve: vi.fn(() => true) as never },
    logger: logger as never,
    randomCode: () => "K7Q2",
  });
  const ensure = vi.fn();
  const ctx: SignalInboundContext = {
    runtime: runtime as never,
    logger: logger as never,
    sessionMap: new ChatSessionMap(join(dir, "signal-session.json")),
    ownerIds: [OWNER],
    account: BOT,
    allowGroups: false,
    bridge,
    send,
    inflight: new Map(),
    ensureApprovalSession: ensure,
    releaseApprovalSession: vi.fn(),
    ...over,
  };
  return { ctx, sent, runTurn, ensure, bridge, logger };
}

describe("handleSignalEnvelope", () => {
  it("runs an owner DM as a turn with origin signal and replies to the sender", async () => {
    const { ctx, sent, runTurn, ensure } = makeCtx();
    await handleSignalEnvelope(dm("what time is it"), ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[1]).toBe("what time is it");
    expect(runTurn.mock.calls[0]?.[2]).toMatchObject({ origin: "signal" });
    expect(ensure).toHaveBeenCalledWith("s-1", { recipient: OWNER });
    expect(sent).toEqual([{ target: { recipient: OWNER }, text: "done" }]);
  });

  it("keeps one session per chat across messages", async () => {
    const { ctx, runTurn } = makeCtx();
    await handleSignalEnvelope(dm("one"), ctx);
    await handleSignalEnvelope(dm("two"), ctx);
    const ids = runTurn.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["s-1", "s-1"]);
  });

  it("drops non-owners and refuses everyone when ownerIds is empty", async () => {
    const stranger = makeCtx();
    await handleSignalEnvelope(dm("hi", "+19990000000"), stranger.ctx);
    expect(stranger.runTurn).not.toHaveBeenCalled();
    expect(stranger.sent).toEqual([]);

    const unpaired = makeCtx({ ownerIds: [] });
    await handleSignalEnvelope(dm("hi"), unpaired.ctx);
    expect(unpaired.runTurn).not.toHaveBeenCalled();
  });

  it("matches an owner by UUID", async () => {
    const uuid = "aaaaaaaa-1111-4111-8111-111111111111";
    const { ctx, runTurn } = makeCtx({ ownerIds: [uuid] });
    await handleSignalEnvelope({ sourceUuid: uuid.toUpperCase(), dataMessage: { message: "hi" } }, ctx);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("ignores its own messages", async () => {
    const { ctx, runTurn } = makeCtx({ ownerIds: [OWNER, BOT] });
    await handleSignalEnvelope(dm("echo", BOT), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("ignores groups unless allowGroups, and then names the sender", async () => {
    const group: SignalEnvelope = {
      sourceNumber: OWNER,
      sourceUuid: "aaaaaaaa-1111-4111-8111-111111111111",
      sourceName: "Ada",
      dataMessage: { message: "status?", groupInfo: { groupId: "R3JvdXA=" } },
    };
    const off = makeCtx();
    await handleSignalEnvelope(group, off.ctx);
    expect(off.runTurn).not.toHaveBeenCalled();

    const on = makeCtx({ allowGroups: true });
    await handleSignalEnvelope(group, on.ctx);
    const prompt = on.runTurn.mock.calls[0]?.[1] as string;
    expect(prompt.split("\n")[0]).toBe(
      '[from] name="Ada" platform=signal user=aaaaaaaa-1111-4111-8111-111111111111 chat=R3JvdXA=',
    );
    expect(on.sent[0]?.target).toEqual({ groupId: "R3JvdXA=" });
  });

  it("consumes an approval answer instead of starting a turn", async () => {
    const { ctx, sent, runTurn, bridge } = makeCtx();
    bridge.handlerFor({ recipient: OWNER })({ approvalId: "ap-1", tool: "t", category: "c", reason: "r" } as never);
    await handleSignalEnvelope(dm("yes K7Q2"), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(sent.at(-1)?.text).toBe("Approved.");
  });

  it("handles /new and /status", async () => {
    const { ctx, sent } = makeCtx();
    await handleSignalEnvelope(dm("hello"), ctx);
    await handleSignalEnvelope(dm("/status"), ctx);
    expect(sent.at(-1)?.text).toBe("This chat is on session s-1.");
    await handleSignalEnvelope(dm("/new"), ctx);
    expect(sent.at(-1)?.text).toMatch(/Previous session s-1 archived/);
    expect(ctx.releaseApprovalSession).toHaveBeenCalledWith("s-1");
    await handleSignalEnvelope(dm("/status"), ctx);
    expect(sent.at(-1)?.text).toBe("No session for this chat yet.");
  });

  it("chunks a long reply at 2000 characters", async () => {
    const long = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`;
    const { ctx, sent } = makeCtx({}, long);
    await handleSignalEnvelope(dm("write a lot"), ctx);
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.text.length <= 2000)).toBe(true);
  });

  it("tells the owner files are not supported yet", async () => {
    const { ctx, sent, runTurn } = makeCtx();
    await handleSignalEnvelope(
      { sourceNumber: OWNER, dataMessage: { message: "", attachments: [{ contentType: "image/png" }] } },
      ctx,
    );
    expect(runTurn).not.toHaveBeenCalled();
    expect(sent[0]?.text).toMatch(/not supported on Signal yet/);
  });

  it("never throws when sending fails", async () => {
    const { ctx } = makeCtx({
      send: async () => {
        throw new Error("signal-cli daemon not reachable");
      },
    });
    await expect(handleSignalEnvelope(dm("/help"), ctx)).resolves.toBeUndefined();
  });
});
