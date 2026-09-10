import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "../../runtime/bootstrap.js";
import { resetConfigCache } from "../../config/index.js";
import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { LlmStreamParams } from "../../agent/step-executor.js";
import type { ApprovalRequest } from "../../approval/approval-gate.js";
import type { BrowserBackend } from "../../tools/browser/browser-backend.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import type { WorkerTaskResult } from "./worker-result.js";

const CLOUD = "cloud-orchestrator";
const LOCAL = "local-llama";

/** A grammar-transport completion carrying `content` as text JSON. */
const completion = (content: string) => ({
  content,
  reasoningContent: "",
  stop: true,
  truncated: false,
  timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
  cacheHitTokens: 0,
  slotId: 0,
  modelId: "fake",
  usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
});

const delegateCall = (tasks: unknown[]) =>
  JSON.stringify([{ tool: "fusion.delegate", args: { tasks } }]);
const replyCall = (text: string) =>
  JSON.stringify([{ tool: "reply", args: { text } }]);

/**
 * The whole fan-out against a real `createAgentRuntime`: a cloud
 * orchestrator turn calls `fusion.delegate`, three worker turns run on
 * the pinned local leg through the real `TurnController`, and the
 * results come back into the orchestrator's own turn.
 *
 * The completion fake is the only stand-in, and it branches on
 * `params.providerId` — which is exactly the pin PR 4 threads down —
 * so "the cloud model" and "the local model" are two different scripts
 * reached through the same seam the product uses.
 */
describe("fusion.delegate end to end", () => {
  let stateDir: string;
  let workingDir: string;
  const backend = {
    ensureReady: async () => {},
    shutdown: async () => {},
  } as unknown as BrowserBackend;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-fusion-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-fusion-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    writeFileSync(
      join(workingDir, "notes.txt"),
      "the file a worker reads\n",
      "utf8",
    );
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({
        version: 52,
        llm: {
          activeTextProvider: CLOUD,
          activeEmbeddingProvider: LOCAL,
          // Force the text-JSON transport for both legs so one fake
          // completion script serves either provider.
          toolTransport: "grammar",
          providers: [
            {
              id: CLOUD,
              kind: "openai-compatible",
              baseUrl: "https://example.invalid",
              apiKey: "test-key",
              defaultChatModel: "orchestrator-model",
            },
            { id: LOCAL, kind: "llama-server", url: "http://127.0.0.1:8080" },
          ],
          runMode: {
            mode: "fusion",
            fusion: {
              orchestratorProvider: CLOUD,
              workerProvider: LOCAL,
              workers: 3,
            },
          },
        },
      }),
      "utf8",
    );
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("fans three workers out on the local leg and merges their replies", async () => {
    const events: Array<{
      event: AgentLoopEvent;
      sessionId: string | undefined;
    }> = [];
    const approvals: ApprovalRequest[] = [];

    // Worker concurrency probe. The first completion of each worker
    // parks until two of them are inside, so "two were in flight" is
    // observed rather than inferred from timing.
    let inFlight = 0;
    let peakInFlight = 0;
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const steps = new Map<string, number>();
    const llamaComplete = async (params: LlmStreamParams) => {
      const step = (steps.get(params.sessionId) ?? 0) + 1;
      steps.set(params.sessionId, step);

      if (params.providerId === LOCAL) {
        if (step === 1) {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          if (inFlight >= 2) openGate();
          // Bounded: a regression that serialises the pool must fail the
          // concurrency assertion, not hang the suite.
          await Promise.race([gate, new Promise((r) => setTimeout(r, 3000))]);
          inFlight -= 1;
          // One worker tries a write; at approval level 1 that is a
          // prompt nobody can answer, so the gate must refuse it.
          const wantsWrite = params.prompt.includes("TASK t3");
          return completion(
            JSON.stringify([
              wantsWrite
                ? {
                    tool: "os.fs.write",
                    args: { path: "out.txt", content: "x" },
                  }
                : { tool: "os.fs.read", args: { path: "notes.txt" } },
            ]),
          );
        }
        return completion(replyCall(`worker done at step ${step}`));
      }

      // The cloud orchestrator: delegate once, then merge.
      if (step === 1) {
        return completion(
          delegateCall([
            { id: "t1", title: "Read one", instructions: "Read notes.txt" },
            {
              id: "t2",
              title: "Read two",
              instructions: "Read notes.txt again",
            },
            { id: "t3", title: "Write one", instructions: "Write out.txt" },
          ]),
        );
      }
      return completion(replyCall("merged all three parts"));
    };

    const runtime = await createAgentRuntime({
      workingDir,
      // Level 1 prompts for everything an approval gate covers.
      approvalLevel: 1,
      handlers: {
        onAgentEvent: (event, sessionId) => events.push({ event, sessionId }),
        onApprovalRequest: (request) => approvals.push(request),
      },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete,
      },
    });
    // A fusion boot is cloud-active, so the local `/props` probe is
    // deferred and the pool starts at one slot. The real runtime widens
    // it inside `warmWorkerBackend`; with the HTTP layer faked away
    // there is no probe to run, so stand in for the resize here.
    runtime.slotManager.resize(4);

    try {
      expect(runtime.toolRegistry.has("fusion.delegate")).toBe(true);
      expect(
        runtime.toolDescriptors.some((d) => d.name === "fusion.delegate"),
      ).toBe(true);

      const parent = runtime.createSession();
      const result = await runtime.runTurn(parent, "split this up", {
        maxSteps: 6,
      });

      expect(result.reason).toBe("reply"); // the orchestrator merged
      expect(result.session.turns.at(-1)).toMatchObject({
        kind: "assistant_reply",
        text: "merged all three parts",
      });

      // Three workers really ran, and at least two at once.
      const workerSessions = [...steps.keys()].filter((id) =>
        id.startsWith(FUSION_WORKER_ID_PREFIX),
      );
      expect(workerSessions).toHaveLength(3);
      expect(peakInFlight).toBeGreaterThanOrEqual(2);

      // Progress reached the host handler tagged with the PARENT id —
      // the worker's own frame has no recorder and no hook, so an event
      // tagged with its id would reach nobody.
      const progress = events.flatMap(({ event, sessionId }) =>
        event.type === "fusion_worker" ? [{ event, sessionId }] : [],
      );
      for (const entry of progress) {
        expect(entry.sessionId).toBe(parent.id);
      }
      const workerLines = progress.filter((e) => e.event.role === "worker");
      const phases = workerLines.map((e) => e.event.phase);
      expect(phases.filter((p) => p === "started")).toHaveLength(3);
      expect(phases.filter((p) => p === "finished")).toHaveLength(3);
      // Every worker line names the model that ran it — here the
      // managed daemon's id, resolved live rather than pinned.
      for (const entry of workerLines) {
        expect(entry.event.model).toBe("local-llama");
      }
      // The workers' own tool calls reach the parent's feed, attributed.
      expect(
        workerLines
          .filter((e) => e.event.phase === "tool")
          .map((e) => e.event.tool)
          .sort(),
      ).toEqual(["os.fs.read", "os.fs.read", "os.fs.write"]);
      // …and the orchestrator claims its own call, on its own model.
      const orchestratorLines = progress.filter(
        (e) => e.event.role === "orchestrator",
      );
      expect(
        orchestratorLines.map((e) => [e.event.phase, e.event.model]),
      ).toEqual([
        ["tool", "orchestrator-model"],
        ["finished", "orchestrator-model"],
      ]);

      // No worker row in the session store: ephemeral means ephemeral.
      const stored = runtime.sessionStore.listRecent(50).map((s) => s.id);
      expect(stored.some((id) => id.startsWith(FUSION_WORKER_ID_PREFIX))).toBe(
        false,
      );
      expect(stored).toContain(parent.id);
      for (const workerId of workerSessions) {
        expect(runtime.sessionStore.load(workerId)).toBeNull();
      }

      // The write was refused, not parked: at level 1 an ordinary
      // session would have raised a prompt, and there is no operator
      // watching a worker session to answer one.
      expect(approvals).toHaveLength(0);
      // The per-task rows ride on the tool result's `details`, which the
      // transcript does not keep — read them off the event stream, the
      // same channel a host UI would.
      const delegateResults = events.flatMap(({ event }) =>
        event.type === "llm_event" &&
        event.event.type === "tool_call_executed" &&
        event.event.result.tool === "fusion.delegate"
          ? [event.event.result]
          : [],
      );
      expect(delegateResults).toHaveLength(1);
      expect(delegateResults[0]!.status).toBe("ok");
      const rows = delegateResults[0]!.details.tasks as WorkerTaskResult[];
      expect(rows.map((r) => r.id)).toEqual(["t1", "t2", "t3"]);
      expect(rows[0]!.status).toBe("ok");
      expect(rows[1]!.status).toBe("ok");
      expect(rows[2]!.status).toBe("needs_orchestrator");
      expect(rows[2]!.tools.byTool["os.fs.write"]).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  it("hides the delegate tool from the workers it starts", async () => {
    // Pinned separately from the policy unit test because the reach of
    // `toolFilter` runs through the runtime: a worker prompt built with
    // the orchestrator's catalog would advertise a recursive fan-out.
    const prompts: Array<{ providerId?: string; prompt: string }> = [];
    const steps = new Map<string, number>();
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async (params: LlmStreamParams) => {
          prompts.push({
            ...(params.providerId ? { providerId: params.providerId } : {}),
            prompt: params.prompt,
          });
          const step = (steps.get(params.sessionId) ?? 0) + 1;
          steps.set(params.sessionId, step);
          return completion(
            params.providerId !== LOCAL && step === 1
              ? delegateCall([
                  { id: "t1", title: "One", instructions: "Do one" },
                ])
              : replyCall("ok"),
          );
        },
      },
    });
    try {
      const parent = runtime.createSession();
      await runtime.runTurn(parent, "delegate one thing", { maxSteps: 4 });
      const orchestratorPrompt = prompts.find((p) => p.providerId !== LOCAL);
      const workerPrompt = prompts.find((p) => p.providerId === LOCAL);
      expect(orchestratorPrompt?.prompt).toContain("fusion.delegate");
      expect(orchestratorPrompt?.prompt).toContain("### fusion");
      expect(workerPrompt).toBeDefined();
      expect(workerPrompt!.prompt).not.toContain("fusion.delegate");
      expect(workerPrompt!.prompt).not.toContain("### fusion");
      expect(workerPrompt!.prompt).toContain(
        "worker agent executing one delegated task",
      );
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);
});
