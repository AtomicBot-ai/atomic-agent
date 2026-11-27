import { describe, expect, it, vi } from "vitest";
import { ApprovalGate, ApprovalGateError, type ApprovalPromptHooks, type ApprovalRequest } from "./approval-gate.js";

const ask = { sessionId: "s1", tool: "os.shell.run", category: "shell" as const, reason: "run git push" };

function hooks(refusal?: string): ApprovalPromptHooks & { seen: ApprovalRequest[]; prompted: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = [];
  const prompted: ApprovalRequest[] = [];
  return {
    seen,
    prompted,
    beforePrompt: async (request) => {
      seen.push(request);
      return refusal;
    },
    onPrompt: (request) => {
      prompted.push(request);
    },
  };
}

describe("ApprovalGate prompt hooks (PermissionRequest / Notification, ATO-2462)", () => {
  it("a PermissionRequest refusal denies without asking the person", async () => {
    const emit = vi.fn();
    const gate = new ApprovalGate({ emit });
    const h = hooks("no pushes on Friday");
    gate.setPromptHooks(h);
    const decision = await gate.request(ask);
    expect(decision).toMatchObject({ approved: false, automatic: true, reason: "Blocked by a PermissionRequest hook: no pushes on Friday" });
    expect(emit).not.toHaveBeenCalled();
    expect(h.prompted).toEqual([]);
    expect(gate.pendingCount()).toBe(0);
  });

  it("no refusal: the prompt goes out and Notification hears it; only the person approves", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r) });
    const h = hooks(undefined);
    gate.setPromptHooks(h);
    const pending = gate.request(ask);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(h.seen).toHaveLength(1);
    expect(h.prompted.map((r) => r.approvalId)).toEqual([emitted[0]!.approvalId]);
    gate.resolve({ approvalId: emitted[0]!.approvalId, approved: true });
    await expect(pending).resolves.toMatchObject({ approved: true });
  });

  it("an auto-approved request never reaches the hooks", async () => {
    const gate = new ApprovalGate({ emit: vi.fn(), level: 5 });
    const h = hooks("would refuse");
    gate.setPromptHooks(h);
    await expect(gate.request(ask)).resolves.toMatchObject({ approved: true });
    expect(h.seen).toEqual([]);
  });

  it("a session under a refuse policy is refused before the hooks", async () => {
    const gate = new ApprovalGate({ emit: vi.fn() });
    const h = hooks(undefined);
    gate.setPromptHooks(h);
    gate.setSessionPolicy("s1", { onPrompt: "refuse", reason: "worker" });
    await expect(gate.request(ask)).resolves.toMatchObject({ approved: false, reason: "worker" });
    expect(h.seen).toEqual([]);
  });

  it("a hook that throws does not block the prompt", async () => {
    const emit = vi.fn();
    const gate = new ApprovalGate({ emit });
    gate.setPromptHooks({ beforePrompt: async () => { throw new Error("boom"); }, onPrompt: () => { throw new Error("boom"); } });
    void gate.request(ask);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
  });

  it("a cancel while the hook runs aborts without a prompt", async () => {
    const emit = vi.fn();
    const gate = new ApprovalGate({ emit });
    const controller = new AbortController();
    gate.setPromptHooks({
      beforePrompt: async () => {
        controller.abort();
        return undefined;
      },
      onPrompt: () => undefined,
    });
    await expect(gate.request(ask, { signal: controller.signal })).rejects.toBeInstanceOf(ApprovalGateError);
    expect(emit).not.toHaveBeenCalled();
  });
});
