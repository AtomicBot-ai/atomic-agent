import { describe, it, expect } from "vitest";
import {
  ApprovalGate,
  canGrantCategory,
  canGrantShape,
} from "./approval-gate.js";

describe("ApprovalGate", () => {
  it("emits a request and resolves with the host decision", async () => {
    let capturedId = "";
    const gate = new ApprovalGate({
      emit: (req) => {
        capturedId = req.approvalId;
        setImmediate(() => gate.resolve({ approvalId: req.approvalId, approved: true }));
      },
    });
    const decision = await gate.request({
      sessionId: "s",
      tool: "apply_patch",
      category: "other",
      reason: "test",
    });
    expect(decision.approved).toBe(true);
    expect(decision.approvalId).toBe(capturedId);
  });

  it("setLevel moves the gate live in both directions", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: false }),
        );
      },
    });
    expect(gate.getLevel()).toBe(1);

    gate.setLevel(5);
    expect(gate.getLevel()).toBe(5);
    const auto = await gate.request({
      sessionId: "s",
      tool: "t",
      category: "shell",
      reason: "r",
    });
    expect(auto.approved).toBe(true);
    expect(auto.reason).toBe("auto-approved (level 5)");
    expect(emitted).toBe(0);

    gate.setLevel(1);
    expect(gate.getLevel()).toBe(1);
    const interactive = await gate.request({
      sessionId: "s",
      tool: "t",
      category: "shell",
      reason: "r",
    });
    expect(interactive.approved).toBe(false);
    expect(emitted).toBe(1);
  });

  it("auto-approves by category from the configured level", async () => {
    const gate = new ApprovalGate({
      emit: () => {
        throw new Error("should not emit when auto-approving");
      },
      level: 5,
    });
    const decision = await gate.request({
      sessionId: "s",
      tool: "run_test",
      category: "other",
      reason: "t",
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("auto-approved (level 5)");
  });

  it("at a mid-ladder level, silences covered categories and prompts the rest", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: false }),
        );
      },
      level: 2,
    });
    const silent = await gate.request({
      sessionId: "s",
      tool: "os.fs.write",
      category: "fs_write_workspace",
      reason: "write",
    });
    expect(silent.approved).toBe(true);
    expect(emitted).toBe(0);

    const asked = await gate.request({
      sessionId: "s",
      tool: "os.fs.write",
      category: "fs_write_home",
      reason: "write",
    });
    expect(asked.approved).toBe(false);
    expect(emitted).toBe(1);
  });

  it("clamps out-of-range setLevel input", () => {
    const gate = new ApprovalGate({ emit: () => {} });
    gate.setLevel(99);
    expect(gate.getLevel()).toBe(5);
    gate.setLevel(-3);
    expect(gate.getLevel()).toBe(1);
    gate.setLevel(Number.NaN);
    expect(gate.getLevel()).toBe(1);
  });

  it("aborts via signal without a host response", async () => {
    const controller = new AbortController();
    const gate = new ApprovalGate({ emit: () => {} });
    const promise = gate.request(
      { sessionId: "s", tool: "apply_patch", category: "other", reason: "t" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "ApprovalGateError" });
  });

  it("y (no grant) never silences the next request of the same category", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: true }),
        );
      },
    });
    const shell = { sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r" } as const;
    await gate.request(shell);
    await gate.request(shell);
    expect(emitted).toBe(2);
    expect(gate.sessionGrants().categories).toEqual([]);
  });

  it("s grants the category for the session: same category goes silent, others still ask", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: true, grant: "category" }),
        );
      },
    });
    const first = await gate.request({
      sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r",
    });
    expect(first.approved).toBe(true);
    expect(emitted).toBe(1);
    expect(gate.sessionGrants().categories).toEqual(["shell"]);

    // Same category: silent, no new prompt.
    const second = await gate.request({
      sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r",
    });
    expect(second.approved).toBe(true);
    expect(second.reason).toBe("auto-approved (session grant)");
    expect(emitted).toBe(1);

    // Different category: still asks.
    const other = await gate.request({
      sessionId: "s", tool: "os.http.request", category: "http", reason: "r",
    });
    expect(other.approved).toBe(true);
    expect(emitted).toBe(2);
  });

  it("a grants a shell command shape: matching binary silent, other binary still asks", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: true, grant: "shape" }),
        );
      },
    });
    await gate.request({
      sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r",
      commandShape: "git",
    });
    expect(gate.sessionGrants().shapes).toEqual(["git"]);
    expect(gate.sessionGrants().categories).toEqual([]);

    const sameShape = await gate.request({
      sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r",
      commandShape: "git",
    });
    expect(sameShape.approved).toBe(true);
    expect(sameShape.reason).toBe("auto-approved (session grant: git)");
    expect(emitted).toBe(1);

    const otherShape = await gate.request({
      sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r",
      commandShape: "curl",
    });
    expect(otherShape.approved).toBe(true);
    expect(emitted).toBe(2);
  });

  it("never grants trust_config, even when the caller asks for a category grant", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: true, grant: "category" }),
        );
      },
    });
    const trust = {
      sessionId: "s", tool: "os.fs.write", category: "trust_config", reason: "config write",
    } as const;
    await gate.request(trust);
    expect(gate.sessionGrants().categories).toEqual([]);

    // The next trust_config write still prompts: the grant was refused.
    await gate.request(trust);
    expect(emitted).toBe(2);
  });

  it("clearSessionGrants drops grants but leaves the standing level", async () => {
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({ approvalId: req.approvalId, approved: true, grant: "category" }),
      level: 3,
    });
    await gate.request({ sessionId: "s", tool: "t", category: "shell", reason: "r" });
    expect(gate.sessionGrants().categories).toEqual(["shell"]);
    gate.clearSessionGrants();
    expect(gate.sessionGrants().categories).toEqual([]);
    expect(gate.sessionGrants().shapes).toEqual([]);
    expect(gate.getLevel()).toBe(3);
  });

  it("a shape grant does not silence a request that carries no commandShape", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: true, grant: "shape" }),
        );
      },
    });
    await gate.request({
      sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r", commandShape: "git",
    });
    // A shell request without a shape (unusual, but defensive) must not
    // ride the shape grant; it still prompts.
    const noShape = await gate.request({
      sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r",
    });
    expect(noShape.approved).toBe(true);
    expect(emitted).toBe(2);
  });

  it("reject() resolves the pending request as denied", async () => {
    let pendingId = "";
    const gate = new ApprovalGate({
      emit: (req) => {
        pendingId = req.approvalId;
      },
    });
    const promise = gate.request({
      sessionId: "s",
      tool: "run_test",
      category: "other",
      reason: "t",
    });
    expect(pendingId.length).toBeGreaterThan(0);
    gate.reject(pendingId, "not safe");
    const decision = await promise;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("not safe");
  });

  it("scopes a category grant to the session that made it (no cross-session leak)", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({
            approvalId: req.approvalId,
            approved: true,
            grant: "category",
          }),
        );
      },
    });
    // Session A grants the shell category.
    await gate.request({
      sessionId: "A", tool: "os.shell.run", category: "shell", reason: "r",
    });
    expect(gate.sessionGrants("A").categories).toEqual(["shell"]);
    expect(emitted).toBe(1);

    // A background-task turn on a *different* session shares the same gate
    // but must NOT ride A's grant — it still prompts.
    const taskTurn = await gate.request({
      sessionId: "B", tool: "os.shell.run", category: "shell", reason: "r",
    });
    expect(taskTurn.approved).toBe(true);
    expect(emitted).toBe(2);
    // B ends up with its own grant, never a view of A's.
    expect(gate.sessionGrants("B").categories).toEqual(["shell"]);
  });

  it("scopes a shape grant to the session that made it", async () => {
    let emitted = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() =>
          gate.resolve({
            approvalId: req.approvalId,
            approved: true,
            grant: "shape",
          }),
        );
      },
    });
    await gate.request({
      sessionId: "A", tool: "os.shell.run", category: "shell", reason: "r",
      commandShape: "git",
    });
    // Same binary, different session → still prompts.
    const otherSession = await gate.request({
      sessionId: "B", tool: "os.shell.run", category: "shell", reason: "r",
      commandShape: "git",
    });
    expect(otherSession.approved).toBe(true);
    expect(emitted).toBe(2);
  });

  it("clearSessionGrants(id) drops one session; no-arg drops all; no-arg snapshot is the union", async () => {
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({
          approvalId: req.approvalId,
          approved: true,
          grant: "category",
        }),
    });
    await gate.request({ sessionId: "A", tool: "t", category: "shell", reason: "r" });
    await gate.request({ sessionId: "B", tool: "t", category: "http", reason: "r" });
    // No-arg snapshot unions across sessions; per-session snapshot is isolated.
    expect(gate.sessionGrants().categories.slice().sort()).toEqual([
      "http",
      "shell",
    ]);
    expect(gate.sessionGrants("A").categories).toEqual(["shell"]);
    expect(gate.sessionGrants("B").categories).toEqual(["http"]);
    // Targeted clear drops only A.
    gate.clearSessionGrants("A");
    expect(gate.sessionGrants("A").categories).toEqual([]);
    expect(gate.sessionGrants("B").categories).toEqual(["http"]);
    // No-arg clear drops the rest.
    gate.clearSessionGrants();
    expect(gate.sessionGrants().categories).toEqual([]);
  });

  it("canGrantCategory / canGrantShape gate the prompt's [s] / [a] offer", () => {
    const shellWithShape = {
      approvalId: "x", sessionId: "s", tool: "os.shell.run",
      category: "shell", reason: "r", commandShape: "git",
    } as const;
    const shellNoShape = {
      approvalId: "x", sessionId: "s", tool: "os.shell.run",
      category: "shell", reason: "r",
    } as const;
    const httpReq = {
      approvalId: "x", sessionId: "s", tool: "os.http.request",
      category: "http", reason: "r",
    } as const;
    const trust = {
      approvalId: "x", sessionId: "s", tool: "os.fs.write",
      category: "trust_config", reason: "r",
    } as const;

    // [s] offered for any grantable category, never for trust_config.
    expect(canGrantCategory(shellWithShape)).toBe(true);
    expect(canGrantCategory(httpReq)).toBe(true);
    expect(canGrantCategory(trust)).toBe(false);

    // [a] only for a shell request carrying a commandShape.
    expect(canGrantShape(shellWithShape)).toBe(true);
    expect(canGrantShape(shellNoShape)).toBe(false);
    expect(canGrantShape(httpReq)).toBe(false);
  });
});
