import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../agent/agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import { LlamaServerError } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import { formatAgentErrorForChat } from "./format-agent-error-for-chat.js";

describe("formatAgentErrorForChat", () => {
  it("prefixes category and message", () => {
    expect(formatAgentErrorForChat("transport", "connection reset")).toBe(
      "Turn failed [transport]: connection reset",
    );
  });

  it("replaces HTML error bodies with a short hint", () => {
    const html =
      "chat completion stream failed: 404 <!DOCTYPE html><html><body>x</body></html>";
    expect(formatAgentErrorForChat("grammar", html)).toBe(
      "Turn failed [grammar]: upstream HTTP 404 (wrong API URL or provider config)",
    );
  });

  it("appends the llama-server hint for transport failures on a local provider", () => {
    const text = formatAgentErrorForChat("transport", "fetch failed", {
      activeProviderIsLocal: true,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).toContain("Turn failed [transport]: fetch failed");
    expect(text).toContain(
      "llama-server is not reachable at http://127.0.0.1:19091",
    );
    expect(text).toContain("atomic-agent models start");
  });

  it("keeps the llama hint away from cloud providers — advice about the wrong server", () => {
    const text = formatAgentErrorForChat("transport", "fetch failed", {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).toContain("Turn failed [transport]: fetch failed");
    expect(text).not.toContain("llama-server is not reachable");
    expect(text).not.toContain("atomic-agent models start");
  });

  it("keeps every hint away from a cloud transport failure that is not a drop", () => {
    expect(
      formatAgentErrorForChat("transport", "upstream HTTP 503", {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe("Turn failed [transport]: upstream HTTP 503");
  });

  // The reported failure: a multi-step research turn whose LLM call died
  // mid-body on a cloud provider. undici's bare word for it is
  // `terminated`, and that single word was the entire message the
  // operator got — nothing about the connection, nothing about the six
  // steps that had already succeeded.
  // Source: Discord #feedback-and-bugs, 2026-09-03.
  it("explains a mid-stream drop and where the finished steps went", () => {
    const text = formatAgentErrorForChat("transport", "terminated", {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).toContain("Turn failed [transport]: terminated");
    expect(text).toContain(
      "the connection to the model dropped before the reply finished",
    );
    expect(text).toContain("kept in this session");
    expect(text).toContain("ask to continue from there");
    expect(text).toContain("re-sending the whole task starts it over");
  });

  it("carries the drop hint with no provider context at all", () => {
    // `chat-orchestrator.ts` calls the formatter without the local
    // context for its own catch arm; a drop must still explain itself.
    expect(formatAgentErrorForChat("transport", "socket hang up")).toContain(
      "the connection to the model dropped before the reply finished",
    );
  });

  it.each([
    "fetch failed",
    "terminated",
    "Client network socket disconnected before secure TLS connection was established",
    "read ECONNRESET: socket hang up",
    "other side closed",
  ])("recognises the drop family: %s", (message) => {
    expect(
      formatAgentErrorForChat("transport", message, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toContain("the steps that already finished are kept in this session");
  });

  it.each([
    "connection reset",
    "upstream HTTP 502 (bad gateway)",
    "request timed out after 120s",
    "terminated the request early",
  ])("leaves unrelated transport failures bare: %s", (message) => {
    expect(
      formatAgentErrorForChat("transport", message, {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe(`Turn failed [transport]: ${message}`);
  });

  it("keeps the drop hint out of non-transport categories", () => {
    expect(formatAgentErrorForChat("tool", "terminated")).toBe(
      "Turn failed [tool]: terminated",
    );
  });

  it("prefers the llama hint when a local provider drops mid-stream", () => {
    // Both arms match. The local one wins: "start llama-server" is a fix,
    // the drop hint is only an explanation.
    const text = formatAgentErrorForChat("transport", "terminated", {
      activeProviderIsLocal: true,
      llamaUrl: "http://127.0.0.1:19091",
    });
    expect(text).toBe(
      [
        "Turn failed [transport]: terminated",
        "llama-server is not reachable at http://127.0.0.1:19091",
        "  start it with:       atomic-agent models start",
        "  or point elsewhere:  atomic-agent config set localModels.url <url>",
      ].join("\n"),
    );
  });

  it("truncates the body, never the hint", () => {
    // Under the 800-char HTML-wall threshold, over the 480-char body cap.
    const long = `socket hang up ${"x".repeat(600)}`;
    const text = formatAgentErrorForChat("transport", long, {
      activeProviderIsLocal: false,
      llamaUrl: "http://127.0.0.1:19091",
    });
    const [head, ...hint] = text.split("\n");
    expect(head!.startsWith("Turn failed [transport]: socket hang up")).toBe(
      true,
    );
    expect(head!.endsWith("…")).toBe(true);
    // 480-char body cap + the "Turn failed [transport]: " prefix + "…".
    expect(head!.length).toBe("Turn failed [transport]: ".length + 480 + 1);
    expect(hint.join("\n")).toBe(
      [
        "the connection to the model dropped before the reply finished",
        "  the steps that already finished are kept in this session — ask to continue from there; re-sending the whole task starts it over",
      ].join("\n"),
    );
  });

  it("keeps the hint away from non-transport failures", () => {
    expect(
      formatAgentErrorForChat("model", "empty completion", {
        activeProviderIsLocal: true,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe("Turn failed [model]: empty completion");
  });
});

const LOCAL = {
  activeProviderIsLocal: true,
  llamaUrl: "http://127.0.0.1:19091",
};

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];

describe("formatAgentErrorForChat — llama failures through the real pipeline", () => {
  // Drives the WHOLE production path, not a hand-composed imitation of
  // it: `AgentLoop` runs a step whose `llmComplete` throws a raw
  // `LlamaServerError`; `executeStep` normalises it through
  // `toLlmFailure`; the loop's catch calls `classifyFailure` on THAT
  // wrapper and emits `loop_failed { category, error }`; the TUI reducer
  // (`agent-event-reducer.ts`, "loop_failed" case) hands exactly those two
  // fields plus the local-provider context to the formatter.
  //
  // The `toLlmFailure` link is the point of the exercise. It used to carry
  // its own hardcoded copy of the llama status split, so a 404 reached the
  // user as `Turn failed [grammar]` however `classifyFailure` was written —
  // and a test that called `formatAgentErrorForChat(classifyFailure(err), …)`
  // directly stayed green while production stayed broken. Route the
  // assertion through the loop and that gap cannot hide.
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-chat-error-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  /**
   * Run one turn whose only LLM call throws `LlamaServerError(status)`,
   * and render the resulting `loop_failed` exactly as the reducer does.
   */
  async function chatTextForLlamaStatus(status: number): Promise<string> {
    const failures: Array<{ category: string; message: string }> = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        throw new LlamaServerError(
          `llama-server returned http ${status}`,
          status,
          LOCAL.llamaUrl,
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_failed") {
          failures.push({
            category: event.category,
            message: event.error.message,
          });
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: `s-llama-${status}`, workingDir }),
      {
        userMessage: "go",
        maxSteps: 3,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(failures).toHaveLength(1);
    return formatAgentErrorForChat(
      failures[0]!.category,
      failures[0]!.message,
      LOCAL,
    );
  }

  it("carries the unreachable hint for a llama 404 on a local provider", async () => {
    // The one failure where "check your llama URL" is exactly the right
    // advice — a wrong `localModels.url`, or a server that is not a
    // llama-server — was the one failure that never got it.
    const text = await chatTextForLlamaStatus(404);
    expect(text).toContain("Turn failed [transport]");
    expect(text).toContain(
      "llama-server is not reachable at http://127.0.0.1:19091",
    );
  });

  it("carries the unreachable hint for a llama 405 on a local provider", async () => {
    const text = await chatTextForLlamaStatus(405);
    expect(text).toContain("Turn failed [transport]");
    expect(text).toContain(
      "llama-server is not reachable at http://127.0.0.1:19091",
    );
  });

  it("keeps a llama 400 as a grammar failure with no URL advice", async () => {
    // Regression guard for the half that is intentionally unchanged: a
    // 400 is the server rejecting THIS request, and the next link would
    // reject it identically.
    const text = await chatTextForLlamaStatus(400);
    expect(text).toBe("Turn failed [grammar]: llama-server returned http 400");
  });
});
