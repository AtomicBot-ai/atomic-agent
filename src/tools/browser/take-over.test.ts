import { describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalDecision, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { GATE_CTX, GateBackend } from "./browser-gate-test-helpers.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";
import type { TakeOverTarget } from "./browser-backend.js";
import { runInBrowserScope } from "./browser-run-scope.js";
import { buildBrowserActTool } from "./index.js";
import { parseTakeOverReason, TAKE_OVER_REASON_MAX } from "./take-over.js";

/**
 * `browser.act { action: "take_over" }` (ATO-508) against the fake
 * backend: the tab is made visible, the turn waits on a person, and the
 * page is read again when they hand it back. The Playwright half (a
 * headless Chrome restarted with a window) is in background-browser.test.ts.
 */

class TakeOverBackend extends GateBackend {
  public prepared = 0;
  public window = true;
  async prepareTakeOver(): Promise<TakeOverTarget> {
    this.prepared += 1;
    return { url: this.url, title: "Sign in", window: this.window };
  }
}

/** A gate that answers every request with `decision`, and lets the test act "while the user has it". */
function answeringGate(
  decision: Omit<ApprovalDecision, "approvalId">,
  whileAsked: () => void = () => undefined,
): { prompts: Array<Record<string, unknown>>; options: DangerousToolOptions } {
  const prompts: Array<Record<string, unknown>> = [];
  const request = async (req: Record<string, unknown>) => {
    prompts.push(req);
    whileAsked();
    return { approvalId: "a", ...decision };
  };
  return { prompts, options: { approvals: { request } as unknown as ApprovalGate, approvalRequired: true } };
}

const LOGIN = { action: "take_over", reason: "log in to shop.example." };

describe("browser.act take_over: the hand-over", () => {
  it("makes the tab visible, then asks as browser_take_over with the reason and Continue / Stop", async () => {
    const backend = new TakeOverBackend();
    const { prompts, options } = answeringGate({ approved: true });
    const result = await buildBrowserActTool(backend, options).run(LOGIN, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(backend.prepared).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      tool: "browser.act",
      category: "browser_take_over",
      reason: "Take over: log in to shop.example. Do it in the browser window, then answer Continue.",
      affectedResources: ["shop.example"],
    });
    expect(String(prompts[0]?.preview)).toContain("Continue (Allow)");
    expect(String(prompts[0]?.preview)).toContain("Stop (Deny)");
    // Nothing is clicked or typed for the user.
    expect(backend.clicks).toHaveLength(0);
    expect(backend.types).toHaveLength(0);
    expect(backend.acts).toHaveLength(0);
  });

  it("Continue: the page is read again after the user acted, into ### world", async () => {
    const backend = new TakeOverBackend();
    const { options } = answeringGate({ approved: true }, () => {
      backend.url = "https://shop.example/account";
    });
    const result = await buildBrowserActTool(backend, options).run(LOGIN, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("handed the browser back");
    expect(result.summary).toContain("https://shop.example/account");
    expect(backend.snapshots).toBe(1);
    expect(result.details).toMatchObject({
      action: "take_over",
      handedBack: true,
      url: "https://shop.example/account",
      view: "interactive",
      worldSnapshot: { kind: "browser" },
    });
  });

  it("Stop: the model is told the user stopped and not to retry, and the page is not read", async () => {
    const backend = new TakeOverBackend();
    const { options } = answeringGate({ approved: false });
    const result = await buildBrowserActTool(backend, options).run(LOGIN, GATE_CTX);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("The user stopped the take-over");
    expect(result.summary).toContain("Do not ask again");
    // Queued browser calls after it in the batch do not run (batch-scheduler.ts).
    expect(result.details).toMatchObject({ handedBack: false, approvalDenied: true, reason: "user_stopped" });
    expect(backend.snapshots).toBe(0);
  });

  it("a refusal nobody made (a refuse policy, a timeout) says nobody could take over, never that the user did it", async () => {
    const backend = new TakeOverBackend();
    const { options } = answeringGate({ approved: false, automatic: true, reason: "no operator" });
    const result = await buildBrowserActTool(backend, options).run(LOGIN, GATE_CTX);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Nobody can take over");
    expect(result.summary).toContain("no operator");
    expect(result.details).toMatchObject({ handedBack: false, reason: "nobody_to_take_over" });
    expect(backend.snapshots).toBe(0);
  });

  it("a Chrome forced headless has no window: nobody is asked", async () => {
    const backend = new TakeOverBackend();
    backend.window = false;
    const { prompts, options } = answeringGate({ approved: true });
    const result = await buildBrowserActTool(backend, options).run(LOGIN, GATE_CTX);
    expect(result.details).toMatchObject({ reason: "no_window" });
    expect(prompts).toHaveLength(0);
  });

  it("a fusion worker cannot hand over: no prompt, no restart of the shared Chrome", async () => {
    const backend = new TakeOverBackend();
    const { prompts, options } = answeringGate({ approved: true });
    const result = await runInBrowserScope({ sessionId: "w1", attended: false, workerOf: "s" }, () =>
      buildBrowserActTool(backend, options).run(LOGIN, GATE_CTX),
    );
    expect(result.details).toMatchObject({ reason: "worker" });
    expect(backend.prepared).toBe(0);
    expect(prompts).toHaveLength(0);
  });

  it("a gate that does not ask (the test seam) is never taken for a person", async () => {
    const backend = new TakeOverBackend();
    const { prompts, options } = answeringGate({ approved: true });
    const result = await buildBrowserActTool(backend, { ...options, approvalRequired: false }).run(LOGIN, GATE_CTX);
    expect(result.details).toMatchObject({ handedBack: false, reason: "no_prompt" });
    expect(prompts).toHaveLength(0);
  });

  it("a blocked host is refused before anything else", async () => {
    const backend = new TakeOverBackend();
    backend.url = "https://bank.example/login";
    const policy: BrowserDomainPolicy = { blockedDomains: ["bank.example"], allowedDomains: [] };
    const { prompts, options } = answeringGate({ approved: true });
    const result = await buildBrowserActTool(backend, options, policy).run(LOGIN, GATE_CTX);
    expect(result.details).toMatchObject({ reason: "blocked_domain" });
    expect(backend.prepared).toBe(0);
    expect(prompts).toHaveLength(0);
  });

  it("the user landing on a blocked host while they have it is not read back", async () => {
    const backend = new TakeOverBackend();
    const policy: BrowserDomainPolicy = { blockedDomains: ["bank.example"], allowedDomains: [] };
    const { options } = answeringGate({ approved: true }, () => {
      backend.url = "https://bank.example/home";
    });
    const result = await buildBrowserActTool(backend, options, policy).run(LOGIN, GATE_CTX);
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ handedBack: true, reason: "blocked_domain" });
  });

  it("works the same in the user's own Chrome, naming their window", async () => {
    const backend = new TakeOverBackend();
    const policy: BrowserDomainPolicy = { blockedDomains: [], allowedDomains: ["shop.example"], userProfile: true };
    const { prompts, options } = answeringGate({ approved: true });
    const result = await buildBrowserActTool(backend, options, policy).run(LOGIN, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(String(prompts[0]?.preview)).toContain("the agent's tab in your Chrome");
  });

  it("needs a reason, and clips a long one", async () => {
    const backend = new TakeOverBackend();
    const { prompts, options } = answeringGate({ approved: true });
    await expect(buildBrowserActTool(backend, options).run({ action: "take_over" }, GATE_CTX)).rejects.toThrow(
      /needs `reason`/,
    );
    expect(prompts).toHaveLength(0);
    expect(parseTakeOverReason({ reason: "x".repeat(1000) }).length).toBe(TAKE_OVER_REASON_MAX);
    expect(parseTakeOverReason({ reason: "  solve\nthe captcha. " })).toBe("solve the captcha");
  });
});

describe("browser.act take_over: only a person answers it", () => {
  /** Run a take-over on a real gate; answer it with `answer` once it is asked. */
  async function onRealGate(gate: ApprovalGate, emitted: ApprovalRequest[], answer: Partial<Pick<ApprovalDecision, "grant">>) {
    const backend = new TakeOverBackend();
    const tool = buildBrowserActTool(backend, { approvals: gate, approvalRequired: true });
    const run = tool.run(LOGIN, GATE_CTX);
    await waitForGate(() => emitted.length > 0);
    const request = emitted.shift()!;
    gate.resolve({ approvalId: request.approvalId, approved: true, ...answer });
    return { request, result: await run };
  }

  it("still asks at full trust (bypass mode), and a session grant does not silence the next one", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r), level: 5 });
    const first = await onRealGate(gate, emitted, { grant: "category" });
    expect(first.request.category).toBe("browser_take_over");
    expect(first.result.status).toBe("ok");
    // Asked again: no grant was recorded for a take-over.
    const second = await onRealGate(gate, emitted, {});
    expect(second.request.category).toBe("browser_take_over");
  });

  it("a session under a refuse policy gets 'nobody to take over' at once", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r), level: 5 });
    gate.setSessionPolicy(GATE_CTX.sessionId, { onPrompt: "refuse", reason: "no operator" });
    const result = await buildBrowserActTool(new TakeOverBackend(), { approvals: gate, approvalRequired: true }).run(
      LOGIN,
      GATE_CTX,
    );
    expect(emitted).toHaveLength(0);
    expect(result.details).toMatchObject({ reason: "nobody_to_take_over" });
  });
});

/** Poll until `ready()` (the tool reaches the gate after a few awaits). */
async function waitForGate(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ready(); i += 1) await new Promise((r) => setTimeout(r, 0));
  if (!ready()) throw new Error("the take-over never reached the gate");
}
