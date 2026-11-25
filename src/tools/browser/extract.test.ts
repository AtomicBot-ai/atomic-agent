import { describe, expect, it } from "vitest";
import { GATE_CTX, GateBackend } from "./browser-gate-test-helpers.js";
import { UserSiteApprovals } from "./user-profile-sites.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";
import { buildBrowserExtractTool, EXTRACT_DEFAULT_PAGE_CHARS, extractPageBudget } from "./extract.js";
import {
  EXTRACT_EMIT_FUNCTION,
  EXTRACT_SESSION_PREFIX,
  parseJsonText,
  type BrowserExtractCompletionParams,
  type BrowserExtractModel,
} from "./extract-request.js";
import { gbnfAccepts } from "../../llm/grammar/gbnf-test-helpers.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";

/** `browser.extract` (ATO-699) against a fake backend and a scripted model. */

const PLANS_SCHEMA = {
  type: "object",
  properties: {
    plans: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, price: { type: "number" } },
        required: ["name", "price"],
        additionalProperties: false,
      },
    },
  },
  required: ["plans"],
  additionalProperties: false,
};

function scriptedModel(
  transport: ToolCallTransport,
  answer: { content?: string; args?: string } | Error,
): { model: BrowserExtractModel; calls: BrowserExtractCompletionParams[] } {
  const calls: BrowserExtractCompletionParams[] = [];
  const model: BrowserExtractModel = {
    async complete(params) {
      calls.push(params);
      if (answer instanceof Error) throw answer;
      return {
        content: answer.content ?? "",
        ...(answer.args !== undefined
          ? { toolCalls: [{ type: "function", function: { name: EXTRACT_EMIT_FUNCTION, arguments: answer.args } }] }
          : {}),
      } as Awaited<ReturnType<BrowserExtractModel["complete"]>>;
    },
    transport: () => transport,
    slotId: () => 3,
  };
  return { model, calls };
}

describe("browser.extract", () => {
  it("constrains a local model with the schema's own grammar and returns the validated JSON", async () => {
    const backend = new GateBackend();
    const { model, calls } = scriptedModel("grammar", { content: '{"plans":[{"name":"Pro","price":9}]}' });
    const result = await buildBrowserExtractTool(backend, undefined, { current: model }).run(
      { schema: PLANS_SCHEMA, instruction: "all plans" },
      GATE_CTX,
    );
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ url: backend.url, data: { plans: [{ name: "Pro", price: 9 }] } });
    expect(result.summary).toContain('"name": "Pro"');
    const call = calls[0]!;
    expect(call.slotId).toBe(3);
    expect(call.sessionId).toBe(`${EXTRACT_SESSION_PREFIX}${GATE_CTX.sessionId}`);
    expect(call.tools).toBeUndefined();
    // The grammar admits the schema's shape and nothing else.
    expect(gbnfAccepts(call.grammar, "root", '{"plans":[{"name":"Pro","price":9}]}')).toBe(true);
    expect(gbnfAccepts(call.grammar, "root", '{"plans":[{"name":"Pro"}]}')).toBe(false);
    expect(gbnfAccepts(call.grammar, "root", "Sure! Here it is")).toBe(false);
  });

  it("keeps the page inside an untrusted block and the instruction outside it", async () => {
    const backend = new GateBackend();
    const { model, calls } = scriptedModel("grammar", { content: '{"plans":[]}' });
    await buildBrowserExtractTool(backend, undefined, { current: model }).run(
      { schema: PLANS_SCHEMA, instruction: "all plans" },
      GATE_CTX,
    );
    const prompt = calls[0]!.prompt;
    const open = prompt.indexOf("<<<UNTRUSTED WEB PAGE ");
    const close = prompt.indexOf("<<<END UNTRUSTED WEB PAGE ");
    expect(open).toBeGreaterThan(-1);
    const page = prompt.indexOf("secret page text");
    expect(page).toBeGreaterThan(open);
    expect(page).toBeLessThan(close);
    expect(prompt.indexOf("all plans")).toBeLessThan(open);
  });

  it("offers one emit function on a native-tools link and reads its arguments", async () => {
    const { model, calls } = scriptedModel("native_tools", { args: '{"plans":[{"name":"Team","price":20}]}' });
    const result = await buildBrowserExtractTool(new GateBackend(), undefined, { current: model }).run(
      { schema: PLANS_SCHEMA },
      { ...GATE_CTX, providerId: "cloud" },
    );
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ data: { plans: [{ name: "Team", price: 20 }] } });
    const call = calls[0]!;
    expect(call.grammar).toBe("");
    expect(call.slotId).toBe(-1);
    expect(call.providerId).toBe("cloud");
    expect(call.tools).toHaveLength(1);
    expect(call.tools![0]).toMatchObject({ function: { name: EXTRACT_EMIT_FUNCTION, parameters: PLANS_SCHEMA } });
  });

  it("wraps a non-object root under `data` for the function call and unwraps it", async () => {
    const schema = { type: "array", items: { type: "string" } };
    const { model, calls } = scriptedModel("native_tools", { args: '{"data":["a","b"]}' });
    const result = await buildBrowserExtractTool(new GateBackend(), undefined, { current: model }).run({ schema }, GATE_CTX);
    expect(result.details).toMatchObject({ data: ["a", "b"] });
    expect(calls[0]!.tools![0]).toMatchObject({
      function: { parameters: { type: "object", properties: { data: schema }, required: ["data"] } },
    });
  });

  it("refuses JSON that does not match the schema and shows what came back", async () => {
    const { model } = scriptedModel("native_tools", { content: '{"plans":[{"name":"Pro","price":"nine"}]}' });
    const result = await buildBrowserExtractTool(new GateBackend(), undefined, { current: model }).run(
      { schema: PLANS_SCHEMA },
      GATE_CTX,
    );
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "schema_mismatch" });
    expect(result.summary).toContain('"nine"');
  });

  it("says so when the model answers without JSON or fails", async () => {
    const prose = scriptedModel("native_tools", { content: "I could not find any plans." });
    const noJson = await buildBrowserExtractTool(new GateBackend(), undefined, { current: prose.model }).run(
      { schema: PLANS_SCHEMA },
      GATE_CTX,
    );
    expect(noJson.details).toMatchObject({ reason: "not_json" });
    const broken = scriptedModel("native_tools", new Error("503 upstream"));
    const failed = await buildBrowserExtractTool(new GateBackend(), undefined, { current: broken.model }).run(
      { schema: PLANS_SCHEMA },
      GATE_CTX,
    );
    expect(failed.details).toMatchObject({ reason: "model_failed" });
    expect(failed.summary).toContain("503 upstream");
  });

  it("rejects bad arguments before touching the page or the model", async () => {
    const backend = new GateBackend();
    const { model, calls } = scriptedModel("grammar", { content: "{}" });
    const tool = buildBrowserExtractTool(backend, undefined, { current: model });
    expect((await tool.run({}, GATE_CTX)).details).toMatchObject({ reason: "bad_schema" });
    expect((await tool.run({ schema: [1] }, GATE_CTX)).details).toMatchObject({ reason: "bad_schema" });
    expect((await tool.run({ schema: { $ref: "#/x" } }, GATE_CTX)).details).toMatchObject({ reason: "bad_schema" });
    expect((await tool.run({ schema: PLANS_SCHEMA, instruction: 5 }, GATE_CTX)).details).toMatchObject({
      reason: "bad_instruction",
    });
    expect(backend.snapshots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("tells the model when no extraction model is wired", async () => {
    const backend = new GateBackend();
    const result = await buildBrowserExtractTool(backend).run({ schema: PLANS_SCHEMA }, GATE_CTX);
    expect(result.details).toMatchObject({ reason: "no_model" });
    expect(backend.snapshots).toBe(0);
  });

  it("never sends a blocked page, or an uncleared site of the user's own Chrome, to the model", async () => {
    const blocked = new GateBackend();
    blocked.url = "https://bank.example/accounts";
    const { model, calls } = scriptedModel("grammar", { content: '{"plans":[]}' });
    const policy: BrowserDomainPolicy = { blockedDomains: ["bank.example"], allowedDomains: [] };
    const refused = await buildBrowserExtractTool(blocked, policy, { current: model }).run({ schema: PLANS_SCHEMA }, GATE_CTX);
    expect(refused.details).toMatchObject({ reason: "blocked_domain", host: "bank.example" });

    const mine = new GateBackend();
    mine.url = "https://mail.example/inbox";
    const userChrome: BrowserDomainPolicy = {
      blockedDomains: [],
      allowedDomains: [],
      userProfile: true,
      userSites: new UserSiteApprovals(),
    };
    const notCleared = await buildBrowserExtractTool(mine, userChrome, { current: model }).run({ schema: PLANS_SCHEMA }, GATE_CTX);
    expect(notCleared.details).toMatchObject({ reason: "user_site_not_cleared", host: "mail.example" });
    expect(calls).toHaveLength(0);
  });

  it("cuts a page longer than the budget and says so", async () => {
    const backend = new GateBackend();
    backend.snapshot = async () => ({ url: backend.url, title: "Long", text: "x".repeat(EXTRACT_DEFAULT_PAGE_CHARS + 10), digest: "d", refs: [] });
    const { model, calls } = scriptedModel("grammar", { content: '{"plans":[]}' });
    const result = await buildBrowserExtractTool(backend, undefined, { current: model }).run({ schema: PLANS_SCHEMA }, GATE_CTX);
    expect(result.details).toMatchObject({ pageTruncated: true });
    expect(calls[0]!.prompt).toContain("The page was cut to fit");
    expect(calls[0]!.prompt).not.toContain("x".repeat(EXTRACT_DEFAULT_PAGE_CHARS + 1));
  });
});

describe("extractPageBudget", () => {
  it("scales with the window inside fixed bounds", () => {
    expect(extractPageBudget(undefined)).toBe(EXTRACT_DEFAULT_PAGE_CHARS);
    expect(extractPageBudget(4_096)).toBe(8_000);
    expect(extractPageBudget(32_768)).toBe(49_152);
    expect(extractPageBudget(1_000_000)).toBe(200_000);
  });
});

describe("parseJsonText", () => {
  it("reads bare, fenced and prose-wrapped JSON, skipping reasoning", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonText('```json\n[1,2]\n```')).toEqual({ ok: true, value: [1, 2] });
    expect(parseJsonText('Here you go: {"a":2} hope it helps')).toEqual({ ok: true, value: { a: 2 } });
    expect(parseJsonText('<think>{"a":0}</think>{"a":3}')).toEqual({ ok: true, value: { a: 3 } });
    expect(parseJsonText("nothing here")).toEqual({ ok: false });
  });
});
