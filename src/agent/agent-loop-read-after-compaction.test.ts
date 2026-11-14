import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { ContextCompactionControl } from "./compaction-control.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { assistantReplyTurn, userTurn } from "../session/conversation-turn.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import type { CapabilitiesSummary, ToolDescriptor } from "../prompt/stable-prefix.js";

/**
 * Follow-up to #827 (mechanism 2). Once a compaction has summarized the
 * earlier reads of a file away, reading it again is how the model gets
 * the content back. The loop tracker must not count the reads from
 * before the compaction against that recovery read.
 */

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const READS = 6;
const readCall = JSON.stringify([{ tool: "os.fs.read", args: { path: "notes.txt" } }]);
const replyCall = JSON.stringify([{ tool: "reply", args: { text: "done" } }]);

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
  { name: "os.fs.read", summary: "Read a file.", argsSchema: '{"path": string}' },
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

/**
 * Compacts right before each step `at` accepts (1-based), every time with
 * a fresh checkpoint object that covers the transcript through row
 * `coveredThrough` (exclusive).
 */
function compactingBefore(
  at: (step: number) => boolean,
  coveredThrough = 1,
): ContextCompactionControl {
  let calls = 0;
  return {
    open() {},
    close() {},
    beforeStep(input: BuildPromptInput) {
      calls += 1;
      if (!at(calls)) return undefined;
      const next: SessionState = {
        ...input.session,
        compaction: {
          version: 1, summary: "read notes.txt several times", coveredThrough, boundaryHash: "x",
          createdAt: Date.now(), reason: "threshold", model: null, kind: "extractive",
          tokensBefore: 9_000, tokensAfter: 1_000,
        },
      };
      return Promise.resolve(next);
    },
  };
}

describe("AgentLoop: a re-read after compaction is not a repeat (#827 follow-up)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-read-after-compaction-"));
    writeFileSync(join(workingDir, "notes.txt"), "hello\n", "utf8");
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  async function readRunsWith(
    compaction: ContextCompactionControl,
    earlierRows = 0,
  ): Promise<number> {
    let readRuns = 0;
    let call = 0;
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "Read a file.",
      readonly: true,
      run: async () => {
        readRuns += 1;
        return compressToolResult({ tool: "os.fs.read", status: "ok", output: "hello", details: {} });
      },
    });
    const agent = new AgentLoop({
      registry,
      slotManager: new SlotManager(1),
      grammar: 'root ::= "ok"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async () => {
        call += 1;
        return completion(call <= READS ? readCall : replyCall);
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      compaction,
    });
    let session = createEmptySessionState({ id: "s-read-after-compaction", workingDir });
    // Rows an earlier turn wrote, before this turn's request.
    for (let row = 0; row < earlierRows; row += 1) {
      session = recordTurn(session, row % 2 === 0 ? userTurn("earlier question") : assistantReplyTurn("earlier answer"));
    }
    await agent.runTurn(session, {
      userMessage: "check the notes",
      maxSteps: 12,
      taskMaxSteps: 12,
      signal: new AbortController().signal,
    });
    return readRuns;
  }

  it("still vetoes the identical read when nothing was compacted", async () => {
    expect(await readRunsWith(compactingBefore(() => false))).toBeLessThan(READS);
  });

  it("runs the recovery read once a compaction has summarized the earlier reads", async () => {
    expect(await readRunsWith(compactingBefore((step) => step === READS))).toBe(READS);
  });

  it("still vetoes the read when the compaction covered only an earlier turn's rows", async () => {
    // Rows 0 and 1 are the earlier turn; this turn starts at row 2, so a
    // checkpoint through row 2 summarized nothing this turn read.
    expect(await readRunsWith(compactingBefore((step) => step === READS, 2), 2)).toBeLessThan(READS);
  });

  it("forgets once per checkpoint, not once per step it is handed back", async () => {
    // The same checkpoint, as a new object before every step: the reads
    // after the first one are all still in view, so the loop is caught.
    expect(await readRunsWith(compactingBefore(() => true))).toBeLessThan(READS);
  });
});
