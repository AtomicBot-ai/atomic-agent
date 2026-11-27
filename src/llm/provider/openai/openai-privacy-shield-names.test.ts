import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalNameDetector,
  privacyVaultFor,
  resetPrivacyVaults,
  setPrivacyNameDetector,
  setPrivacyShieldEnabled,
  type LocalNameDetector,
  type LocalNameModel,
} from "../../../privacy/index.js";
import { learnNamesForRequest, maskOpenAiBody, messageTextsForNames } from "./openai-privacy-shield.js";
import { OpenAiProvider } from "./openai-provider.js";

afterEach(() => resetPrivacyVaults());

const TEXT = "Book a table for Иван Петров, ivan@example.com";

function localModel(spans: { text: string; kind: string }[]) {
  const complete = vi.fn(async (_input: { user: string }) => JSON.stringify({ spans }));
  const model: LocalNameModel = { id: "local", local: true, complete };
  return Object.assign(model, { complete });
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "Done for [NAME_1]." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function cloud(fetchImpl: unknown, baseUrl = "https://api.example.invalid"): OpenAiProvider {
  return new OpenAiProvider({ id: "cloud", baseUrl, apiKey: "", defaultChatModel: "m", fetchImpl: fetchImpl as typeof fetch });
}

describe("messageTextsForNames (ATO-2394)", () => {
  it("reads every message but the system prompt, parts included", () => {
    expect(
      messageTextsForNames([
        { role: "system", content: "You are Atomic Agent." },
        { role: "user", content: "Hi, I am Anna Lee" },
        { role: "user", content: [{ type: "text", text: "from Acme" }, { type: "image_url", image_url: { url: "x" } }] },
        { role: "tool", content: "Bob Ray replied" },
        { role: "assistant", content: null },
      ]),
    ).toEqual(["Hi, I am Anna Lee", "from Acme", "Bob Ray replied"]);
    expect(messageTextsForNames(undefined)).toEqual([]);
  });

  it("reads assistant replies too on a vault's first pass", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Anna Lee asked for the invoice" },
      { role: "assistant", content: null },
    ];
    expect(messageTextsForNames(messages)).toEqual(["hello"]);
    expect(messageTextsForNames(messages, { replies: true })).toEqual(["hello", "Anna Lee asked for the invoice"]);
  });
});

describe("learnNamesForRequest (ATO-2394)", () => {
  it("teaches the vault what the local model found, so the body masks it", async () => {
    setPrivacyNameDetector(createLocalNameDetector({ model: () => localModel([{ text: "Иван Петров", kind: "NAME" }]) }));
    const vault = privacyVaultFor("s1");
    const messages = [{ role: "user", content: TEXT }];
    await learnNamesForRequest(vault, () => messages);
    const body: Record<string, unknown> = { messages };
    maskOpenAiBody(body, vault);
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({ messages: [{ role: "user", content: "Book a table for [NAME_1], [EMAIL_1]" }] }),
    );
  });

  it("does not build the messages without a detector", async () => {
    const readMessages = vi.fn(() => []);
    await learnNamesForRequest(privacyVaultFor("s1"), readMessages);
    expect(readMessages).not.toHaveBeenCalled();
  });

  it("leaves the vault as it was when the detector or the messages fail", async () => {
    const broken: LocalNameDetector = { detect: () => Promise.reject(new Error("boom")), calls: 0 };
    setPrivacyNameDetector(broken);
    const vault = privacyVaultFor("s1");
    await learnNamesForRequest(vault, () => [{ role: "user", content: TEXT }]);
    setPrivacyNameDetector(createLocalNameDetector({ model: () => localModel([]) }));
    await learnNamesForRequest(vault, () => {
      throw new Error("body failed");
    });
    expect(vault.isEmpty).toBe(true);
    expect(vault.mask(TEXT)).toBe("Book a table for Иван Петров, [EMAIL_1]");
  });
});

describe("OpenAiProvider with the local name pass (ATO-2394)", () => {
  it("sends names as placeholders to a cloud model and puts them back in the reply", async () => {
    setPrivacyShieldEnabled(true);
    const model = localModel([{ text: "Иван Петров", kind: "NAME" }]);
    setPrivacyNameDetector(createLocalNameDetector({ model: () => model }));
    const fetchImpl = vi.fn(async () => okResponse());
    const result = await cloud(fetchImpl).complete({ prompt: TEXT, sessionId: "s1" });
    const sent = String(((fetchImpl.mock.calls[0] as unknown[] | undefined)?.[1] as RequestInit).body);
    expect(sent).not.toContain("Иван");
    expect(sent).not.toContain("ivan@example.com");
    expect(sent).toContain("[NAME_1]");
    expect(result.content).toBe("Done for Иван Петров.");
    // The local model saw the real text; the cloud never did.
    expect(model.complete.mock.calls[0]?.[0].user).toContain("Иван Петров");
  });

  it("sends the regex-masked text when the local model fails", async () => {
    setPrivacyShieldEnabled(true);
    const model: LocalNameModel = { id: "local", local: true, complete: () => Promise.reject(new Error("down")) };
    setPrivacyNameDetector(createLocalNameDetector({ model: () => model }));
    const fetchImpl = vi.fn(async () => okResponse());
    await cloud(fetchImpl).complete({ prompt: TEXT, sessionId: "s1" });
    const sent = String(((fetchImpl.mock.calls[0] as unknown[] | undefined)?.[1] as RequestInit).body);
    expect(sent).toContain("Иван Петров");
    expect(sent).not.toContain("ivan@example.com");
  });

  it("never runs the pass for a local server or with the shield off", async () => {
    const model = localModel([{ text: "Иван Петров", kind: "NAME" }]);
    setPrivacyNameDetector(createLocalNameDetector({ model: () => model }));
    setPrivacyShieldEnabled(false);
    await cloud(vi.fn(async () => okResponse())).complete({ prompt: TEXT, sessionId: "s1" });
    setPrivacyShieldEnabled(true);
    await cloud(vi.fn(async () => okResponse()), "http://127.0.0.1:8080/v1").complete({ prompt: TEXT, sessionId: "s1" });
    expect(model.complete).not.toHaveBeenCalled();
  });
});
