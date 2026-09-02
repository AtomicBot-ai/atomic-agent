import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTRACT_PROBE_TOOL_NAME } from "../../llm/provider/verify/index.js";
import { probeWizardContract } from "./probe-wizard-contract.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardState,
} from "./providers-wizard-state.js";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "AIMLAPI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_API_KEY",
  "LMSTUDIO_API_KEY",
] as const;

function wizard(
  kind: ProvidersWizardKind,
  overrides: Partial<ProvidersWizardState> = {},
): ProvidersWizardState {
  return {
    ...createProvidersWizardState("add", { kind }),
    phase: "api_key",
    apiKeyBuffer: "sk-test-key",
    ...overrides,
  };
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const TOOL_CALL_STREAM =
  sseEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: CONTRACT_PROBE_TOOL_NAME, arguments: '{"ok":true}' },
            },
          ],
        },
      },
    ],
  }) +
  sseEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
  "data: [DONE]\n\n";

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("probeWizardContract", () => {
  it("proves a route that streams a native tool call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(TOOL_CALL_STREAM, { status: 200 })),
    );
    const outcome = await probeWizardContract(wizard("openrouter"));
    expect(outcome.proven).toBe(true);
    expect(outcome.warning).toBeNull();
    expect(outcome.summary).toContain("can run a turn");
  });

  it("warns without blocking when the route refuses the tools payload", async () => {
    // Refuses with tools twice, answers the no-tools control: the
    // route works, and it is `tools` it will not take.
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        if (bodies.length <= 2) return new Response("Bad Request", { status: 400 });
        return new Response(
          sseEvent({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
          { status: 200 },
        );
      }),
    );
    const outcome = await probeWizardContract(wizard("aimlapi"));
    expect(outcome.proven).toBe(false);
    expect(outcome.warning).toContain('"tools"');
    // Advisory only: nothing here can refuse a save.
    expect(outcome.result?.status).toBe("tools_payload_rejected");
  });

  it("does not call an inconclusive auto answer a failure of the route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = String(init?.body ?? "");
        if (body.includes('"tool_choice":{')) {
          return new Response("Bad Request", { status: 400 });
        }
        return new Response(
          sseEvent({ choices: [{ delta: { content: "Sure!" }, finish_reason: "stop" }] }),
          { status: 200 },
        );
      }),
    );
    const outcome = await probeWizardContract(wizard("openrouter"));
    expect(outcome.result?.status).toBe("inconclusive_no_tool_call");
    expect(outcome.warning).toContain("Inconclusive");
    // "Unproven" is not "incompatible", and the wording must not drift.
    expect(outcome.warning).not.toContain("cannot");
  });

  it("never calls out for a server on this machine", async () => {
    const fetchMock = vi.fn(async () => new Response(TOOL_CALL_STREAM, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await probeWizardContract(
      wizard("openai-compatible", {
        apiKeyBuffer: "",
        baseUrlLine: "http://127.0.0.1:8000",
      }),
    );
    expect(outcome.proven).toBe(false);
    // A skip is not a warning: a local server is not a defect to report.
    expect(outcome.warning).toBeNull();
    expect(outcome.skipped).toBe("local_endpoint");
    expect(outcome.summary).toContain("server on this machine");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never calls out for a CLI-backed provider", async () => {
    const fetchMock = vi.fn(async () => new Response(TOOL_CALL_STREAM, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await probeWizardContract(wizard("claude-cli"));
    expect(outcome.skipped).toBe("cli_backed");
    expect(outcome.warning).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says a key is missing rather than pretending there is nothing to check", async () => {
    const fetchMock = vi.fn(async () => new Response(TOOL_CALL_STREAM, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await probeWizardContract(
      wizard("openrouter", { apiKeyBuffer: "" }),
    );
    expect(outcome.skipped).toBe("no_api_key");
    expect(outcome.summary).toContain("no API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes the model the operator picked, not a cheap stand-in", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(TOOL_CALL_STREAM, { status: 200 });
      }),
    );
    await probeWizardContract(
      wizard("openrouter", { selectedChatModelId: "vendor/chosen-model" }),
    );
    expect(bodies[0]).toContain("vendor/chosen-model");
  });
});
