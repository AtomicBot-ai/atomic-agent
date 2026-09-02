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

  it("keeps the hint away from cloud providers — advice about the wrong server", () => {
    expect(
      formatAgentErrorForChat("transport", "fetch failed", {
        activeProviderIsLocal: false,
        llamaUrl: "http://127.0.0.1:19091",
      }),
    ).toBe("Turn failed [transport]: fetch failed");
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
