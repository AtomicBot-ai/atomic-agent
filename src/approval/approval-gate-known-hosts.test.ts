import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";
import { ApprovalRulesStore } from "./approval-rules-store.js";
import type { EgressDestination } from "./egress-scan.js";

const toGithub: EgressDestination = { kind: "git_remote", host: "github.com", direction: "outbound", label: "github.com" };

function push(sessionId: string) {
  return {
    sessionId,
    tool: "os.shell.run",
    category: "shell" as const,
    reason: "git push",
    preview: "git push origin main",
    commandArgv: ["git", "push", "origin", "main"],
    commandSegments: [["git", "push", "origin", "main"]],
    egress: [toGithub],
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * ATO-2528: without durable known hosts, `git push` to github.com at
 * level 5 asked once in every new session. A host on
 * `agent.security.knownHosts` no longer holds the call, and "allow
 * always" on a held call keeps its hosts there.
 */
describe("ApprovalGate durable known hosts (ATO-2528)", () => {
  let stateDir: string;
  let emitted: ApprovalRequest[];
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "gate-known-hosts-"));
    emitted = [];
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("a host on knownHosts does not hold the call in bypass", async () => {
    const g = new ApprovalGate({ emit: (r) => emitted.push(r), level: 5 });
    g.setEgressKnownHosts(() => ["github.com"]);
    await expect(g.request(push("s1"))).resolves.toMatchObject({ approved: true });
    expect(emitted).toHaveLength(0);
  });

  it("a subdomain entry covers the domain, and a broken reader makes no host known", async () => {
    const g = new ApprovalGate({ emit: (r) => emitted.push(r), level: 5 });
    g.setEgressKnownHosts(() => ["*.github.com"]);
    await expect(g.request(push("s1"))).resolves.toMatchObject({ approved: true });
    g.setEgressKnownHosts(() => {
      throw new Error("no config");
    });
    void g.request(push("s2"));
    await settle();
    expect(emitted).toHaveLength(1);
  });

  it('"allow always" on a held call keeps its hosts, so a new session does not ask', async () => {
    const known: string[] = [];
    const g = new ApprovalGate({ emit: (r) => emitted.push(r), level: 5 });
    g.setRules(new ApprovalRulesStore({ stateDir }));
    g.setEgressKnownHosts(
      () => known,
      (hosts) => known.push(...hosts),
    );
    const first = g.request(push("s1"));
    await settle();
    expect(emitted).toHaveLength(1);
    g.resolve({ approvalId: emitted[0]!.approvalId, approved: true, grant: "always" });
    await first;
    expect(known).toEqual(["github.com"]);
    await expect(g.request(push("s2"))).resolves.toMatchObject({ approved: true });
    expect(emitted).toHaveLength(1);
  });

  it("a one-off approval keeps nothing", async () => {
    const known: string[] = [];
    const g = new ApprovalGate({ emit: (r) => emitted.push(r), level: 5 });
    g.setEgressKnownHosts(
      () => known,
      (hosts) => known.push(...hosts),
    );
    const first = g.request(push("s1"));
    await settle();
    g.resolve({ approvalId: emitted[0]!.approvalId, approved: true });
    await first;
    expect(known).toEqual([]);
  });
});
