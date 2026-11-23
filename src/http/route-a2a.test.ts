import { afterEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../llm/llama-server-client.js";
import type { ConversationTurn } from "../session/conversation-turn.js";

import {
  A2A_ERRORS,
  A2A_PROTOCOL_VERSION,
  a2aStateFor,
  buildAgentCard,
  parseSendParams,
  taskReplyText,
} from "./route-a2a.js";
import { startTestHarness, type Harness } from "./test-harness.js";

const KEY = "a2a-test-key-0123456789";

interface RpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: {
    kind: string;
    id: string;
    contextId: string;
    status: { state: string; message?: { parts: Array<{ kind: string; text: string }> } };
    artifacts?: Array<{ parts: Array<{ text: string }> }>;
    history?: unknown[];
  };
  error?: { code: number; message: string };
}

function replyWith(text: string): CompletionResult {
  return {
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 4, predictedTokens: 2 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  };
}

function textMessage(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "message", messageId: `m-${Math.random()}`, role: "user", parts: [{ kind: "text", text }], ...extra };
}

describe("A2A agent card and JSON-RPC (ATO-693)", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function rpc(body: unknown, key: string | null = KEY): Promise<{ status: number; json: RpcResponse }> {
    const res = await fetch(`${harness!.baseUrl}/api/a2a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as RpcResponse };
  }

  it("is off by default: neither the card nor the endpoint exists", async () => {
    harness = await startTestHarness({ apiKey: KEY });
    const card = await fetch(`${harness.baseUrl}/.well-known/agent-card.json`);
    expect(card.status).toBe(404);
    const call = await fetch(`${harness.baseUrl}/api/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } }),
    });
    expect(call.status).toBe(404);
  });

  it("serves a public agent card naming the endpoint and the bearer key", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: {} });
    const res = await fetch(`${harness.baseUrl}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as Record<string, unknown>;
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(card.name).toBe("Atomic Agent");
    expect(card.url).toBe(`${harness.baseUrl}/api/a2a`);
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.capabilities).toMatchObject({ streaming: false });
    expect(card.securitySchemes).toMatchObject({ bearer: { type: "http", scheme: "bearer" } });
    expect(card.security).toEqual([{ bearer: [] }, { apiKey: [] }]);
    expect(Array.isArray(card.skills) && card.skills.length).toBeGreaterThan(0);
  });

  it("uses the configured public URL in the card", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: { publicUrl: "https://agent.example.com/" } });
    const card = (await (await fetch(`${harness.baseUrl}/.well-known/agent-card.json`)).json()) as { url: string };
    expect(card.url).toBe("https://agent.example.com/api/a2a");
  });

  it("refuses the JSON-RPC endpoint without the API key", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: {} });
    const { status } = await rpc({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } }, null);
    expect(status).toBe(401);
    const wrong = await rpc({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } }, "wrong-key-0123456789");
    expect(wrong.status).toBe(401);
  });

  it("message/send files a task in a new A2A context and tasks/get reads its reply", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: {} });
    const sent = await rpc({ jsonrpc: "2.0", id: "send-1", method: "message/send", params: { message: textMessage("say hi") } });
    expect(sent.status).toBe(200);
    expect(sent.json.id).toBe("send-1");
    expect(sent.json.error).toBeUndefined();
    const task = sent.json.result!;
    expect(task.kind).toBe("task");
    expect(task.contextId).toMatch(/^s-/);

    const record = harness.runtime.taskStore.get(task.id);
    expect(record?.userMessage).toBe("say hi");
    expect(harness.runtime.sessionStore.load(task.contextId)?.metadata.source).toBe("a2a");

    await harness.runtime.taskRunner.drainPending({ sessionId: task.contextId });
    const got = await rpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: task.id } });
    expect(got.json.result?.status.state).toBe("completed");
    expect(got.json.result?.artifacts?.[0]?.parts[0]?.text).toBe("hi back");
    expect(got.json.result?.status.message?.parts[0]?.text).toBe("hi back");
  });

  it("blocking message/send answers once the task has settled", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: {} });
    const sent = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: textMessage("say hi"), configuration: { blocking: true, historyLength: 0 } },
    });
    expect(sent.json.result?.status.state).toBe("completed");
    expect(sent.json.result?.history).toBeUndefined();
  });

  it("a second message with the returned contextId continues the same chat", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: {} });
    const first = await rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: textMessage("one") } });
    const contextId = first.json.result!.contextId;
    const second = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "message/send",
      params: { message: textMessage("two", { contextId }) },
    });
    expect(second.json.result?.contextId).toBe(contextId);
  });

  it("tasks/get answers each task in one context with its own reply, also while a later one runs", async () => {
    // The second task's model call waits on a gate, so the session tail is
    // its user turn while tasks/get reads the first task.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let secondStarted = false;
    harness = await startTestHarness({
      apiKey: KEY,
      a2a: {},
      llamaComplete: async ({ prompt }) => {
        if (prompt.includes("beta-question-222")) {
          secondStarted = true;
          await gate;
          return replyWith("reply-beta");
        }
        return replyWith("reply-alpha");
      },
    });
    const h = harness;
    const first = await rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: textMessage("alpha-question-111") } });
    const t1 = first.json.result!;
    await h.runtime.taskRunner.drainPending({ sessionId: t1.contextId });
    expect(h.runtime.taskStore.get(t1.id)?.status).toBe("completed");

    const second = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "message/send",
      params: { message: textMessage("beta-question-222", { contextId: t1.contextId }) },
    });
    const t2 = second.json.result!;
    expect(t2.contextId).toBe(t1.contextId);
    const draining = h.runtime.taskRunner.drainPending({ sessionId: t1.contextId });
    for (let i = 0; i < 200 && !secondStarted; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(secondStarted).toBe(true);

    const whileRunning = await rpc({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: t1.id } });
    expect(whileRunning.json.result?.status.state).toBe("completed");
    expect(whileRunning.json.result?.artifacts?.[0]?.parts[0]?.text).toBe("reply-alpha");

    release();
    await draining;
    for (let i = 0; i < 200 && h.runtime.taskStore.get(t2.id)?.status !== "completed"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const got1 = await rpc({ jsonrpc: "2.0", id: 4, method: "tasks/get", params: { id: t1.id } });
    expect(got1.json.result?.artifacts?.[0]?.parts[0]?.text).toBe("reply-alpha");
    expect(got1.json.result?.status.message?.parts[0]?.text).toBe("reply-alpha");
    const got2 = await rpc({ jsonrpc: "2.0", id: 5, method: "tasks/get", params: { id: t2.id } });
    expect(got2.json.result?.status.state).toBe("completed");
    expect(got2.json.result?.artifacts?.[0]?.parts[0]?.text).toBe("reply-beta");
  });

  it("never attaches to, or reads tasks of, the person's own chats", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: {} });
    const own = harness.runtime.createSession();
    const sent = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: textMessage("hello", { contextId: own.id }) },
    });
    expect(sent.json.result?.contextId).not.toBe(own.id);

    const local = harness.runtime.taskRunner.create({ sessionId: own.id, userMessage: "private", origin: "cli", maxAttempts: 1 });
    const got = await rpc({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: local.id } });
    expect(got.json.error?.code).toBe(A2A_ERRORS.taskNotFound);
    const cancel = await rpc({ jsonrpc: "2.0", id: 3, method: "tasks/cancel", params: { id: local.id } });
    expect(cancel.json.error?.code).toBe(A2A_ERRORS.taskNotFound);
  });

  it("tasks/cancel refuses a finished task", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: {} });
    const sent = await rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: textMessage("hi") } });
    const task = sent.json.result!;
    await harness.runtime.taskRunner.drainPending({ sessionId: task.contextId });
    const cancel = await rpc({ jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { id: task.id } });
    expect(cancel.json.error?.code).toBe(A2A_ERRORS.taskNotCancelable);
  });

  it("answers JSON-RPC errors for bad input and methods it does not have", async () => {
    harness = await startTestHarness({ apiKey: KEY, a2a: {} });
    expect((await rpc("{not json")).json.error?.code).toBe(A2A_ERRORS.parseError);
    expect((await rpc({ id: 1, method: "tasks/get" })).json.error?.code).toBe(A2A_ERRORS.invalidRequest);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "nope" })).json.error?.code).toBe(A2A_ERRORS.methodNotFound);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "message/stream", params: {} })).json.error?.code).toBe(
      A2A_ERRORS.unsupportedOperation,
    );
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} })).json.error?.code).toBe(
      A2A_ERRORS.invalidParams,
    );
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "t-missing" } })).json.error?.code).toBe(
      A2A_ERRORS.taskNotFound,
    );
  });
});

describe("A2A helpers", () => {
  it("parseSendParams takes text parts and refuses the rest", () => {
    const parsed = parseSendParams({
      message: textMessage("a", { parts: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }] }),
      configuration: { blocking: true },
    });
    expect(parsed.text).toBe("a\n\nb");
    expect(parsed.blocking).toBe(true);
    expect(() =>
      parseSendParams({ message: textMessage("x", { parts: [{ kind: "file", file: { uri: "https://x" } }] }) }),
    ).toThrow(/text parts/);
    expect(() => parseSendParams({ message: textMessage("x", { role: "agent" }) })).toThrow(/role/);
    expect(() => parseSendParams({ message: textMessage("x", { taskId: "t-1" }) })).toThrow(/not supported/);
    expect(() =>
      parseSendParams({ message: textMessage("x"), configuration: { acceptedOutputModes: ["image/png"] } }),
    ).toThrow(/text\/plain/);
  });

  it("maps every task status onto an A2A state", () => {
    expect(a2aStateFor("pending")).toBe("submitted");
    expect(a2aStateFor("paused")).toBe("submitted");
    expect(a2aStateFor("running")).toBe("working");
    expect(a2aStateFor("completed")).toBe("completed");
    expect(a2aStateFor("cancelled")).toBe("canceled");
    expect(a2aStateFor("failed")).toBe("failed");
    expect(a2aStateFor("blocked")).toBe("failed");
  });

  it("taskReplyText reads the reply inside the task's own run window", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "one", at: 100 },
      { kind: "assistant_reply", text: "note", progressNote: true, at: 110 },
      { kind: "assistant_reply", text: "reply one", at: 120 },
      { kind: "user", text: "two", at: 200 },
      { kind: "assistant_reply", text: "reply two", at: 220 },
    ];
    expect(taskReplyText(turns, { startedAt: 100, completedAt: 130, updatedAt: 130 })).toBe("reply one");
    expect(taskReplyText(turns, { startedAt: 200, completedAt: 230, updatedAt: 230 })).toBe("reply two");
    // A later task still running: the earlier task keeps its reply.
    expect(taskReplyText(turns.slice(0, 4), { startedAt: 100, completedAt: 130, updatedAt: 130 })).toBe("reply one");
    // Never started: no reply.
    expect(taskReplyText(turns, { startedAt: null, completedAt: null, updatedAt: 0 })).toBeUndefined();
  });

  it("buildAgentCard carries the version it is given", () => {
    expect(buildAgentCard("http://h:1", "9.9.9").version).toBe("9.9.9");
  });
});
