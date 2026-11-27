import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalNameDetector,
  privacyVaultFor,
  resetPrivacyVaults,
  setPrivacyNameDetector,
  setPrivacyShieldEnabled,
  type LocalNameModel,
} from "../../../privacy/index.js";
import type { CompletionRequest } from "../completion-types.js";
import { learnNamesForRequest, maskOpenAiBody } from "./openai-privacy-shield.js";
import { OpenAiProvider } from "./openai-provider.js";

/**
 * ATO-2527: the shield masks names BEFORE the cloud call, including the
 * ways a name could slip past the local pass: written in a tool result,
 * split across two content parts. The fake local model behaves like a
 * real one: it reports a span only when the text it was shown contains it.
 */

afterEach(() => {
  resetPrivacyVaults();
  setPrivacyShieldEnabled(false);
});

function readingModel(known: { text: string; kind: string }[]) {
  const complete = vi.fn(async ({ user }: { user: string }) =>
    JSON.stringify({ spans: known.filter((s) => user.includes(s.text)) }),
  );
  const model: LocalNameModel = { id: "local", local: true, complete };
  return Object.assign(model, { complete });
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>): string {
  return String(((fetchImpl.mock.calls[0] as unknown[] | undefined)?.[1] as RequestInit).body);
}

const tools = [{ type: "function" as const, function: { name: "mail__read", parameters: { type: "object" } } }];

function nativeRequest(toolBody: string, reply = "Reading it now."): CompletionRequest {
  return {
    prompt: "flat",
    sessionId: "s-bypass",
    tools,
    messages: {
      system: "sys",
      droppedSummary: null,
      tail: "",
      turns: [
        { kind: "user", text: "read my last email" },
        { kind: "assistant_reply", text: reply },
        { kind: "user", text: "go on" },
        { kind: "assistant_tool_call", tool: "mail.read", args: {}, callId: "c1" },
        { kind: "tool_result", tool: "mail.read", status: "ok", body: toolBody, truncated: false, callId: "c1" },
      ],
    },
  } as CompletionRequest;
}

describe("Privacy Shield names before the cloud call (ATO-2527)", () => {
  it("masks a name that only a tool result carries", async () => {
    setPrivacyShieldEnabled(true);
    const model = readingModel([{ text: "Мария Соколова", kind: "NAME" }]);
    setPrivacyNameDetector(createLocalNameDetector({ model: () => model }));
    const fetchImpl = vi.fn(async () => okResponse());
    const cloud = new OpenAiProvider({ id: "cloud", baseUrl: "https://api.example.invalid", apiKey: "", defaultChatModel: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
    await cloud.complete(nativeRequest("From: Мария Соколова\nSubject: invoice"));
    const sent = sentBody(fetchImpl);
    expect(sent).not.toContain("Мария");
    expect(sent).not.toContain("Соколова");
    expect(sent).toContain("[NAME_1]");
    // The local model read the tool result before anything went out.
    expect(model.complete).toHaveBeenCalled();
    expect(model.complete.mock.invocationCallOrder[0]).toBeLessThan(fetchImpl.mock.invocationCallOrder[0]!);
  });

  it("does not send the assistant's own replies to the local model", async () => {
    setPrivacyShieldEnabled(true);
    const model = readingModel([]);
    setPrivacyNameDetector(createLocalNameDetector({ model: () => model }));
    const fetchImpl = vi.fn(async () => okResponse());
    const cloud = new OpenAiProvider({ id: "cloud", baseUrl: "https://api.example.invalid", apiKey: "", defaultChatModel: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
    await cloud.complete(nativeRequest("nothing here", "A long reply the cloud wrote itself."));
    const shown = model.complete.mock.calls.map((c) => c[0].user).join("\n");
    expect(shown).toContain("read my last email");
    expect(shown).toContain("nothing here");
    expect(shown).not.toContain("A long reply the cloud wrote itself.");
  });

  it("masks a name split across two content parts of one message", async () => {
    const model = readingModel([{ text: "Иван Петров", kind: "NAME" }]);
    setPrivacyNameDetector(createLocalNameDetector({ model: () => model }));
    const vault = privacyVaultFor("s-parts");
    const messages = [
      { role: "user", content: [{ type: "text", text: "Call Иван" }, { type: "text", text: " Петров tomorrow" }] },
    ];
    await learnNamesForRequest(vault, () => messages);
    const body: Record<string, unknown> = { messages };
    maskOpenAiBody(body, vault);
    const sent = JSON.stringify(body);
    expect(sent).not.toContain("Иван");
    expect(sent).not.toContain("Петров");
    expect(sent).toContain("tomorrow");
  });

  it("leaves an ordinary word the model called an organisation readable", async () => {
    const model = readingModel([
      { text: "support", kind: "ORG" },
      { text: "Acme Logistics", kind: "ORG" },
    ]);
    setPrivacyNameDetector(createLocalNameDetector({ model: () => model }));
    const vault = privacyVaultFor("s-org");
    const messages = [{ role: "user", content: "Ask support at Acme Logistics" }];
    await learnNamesForRequest(vault, () => messages);
    const body: Record<string, unknown> = { messages };
    maskOpenAiBody(body, vault);
    expect(JSON.stringify(body)).toContain("Ask support at [ORG_1]");
  });
});
