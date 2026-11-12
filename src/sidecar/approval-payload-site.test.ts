import { describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../approval/approval-gate.js";
import { approvalRequestPayload, resolveApprovalResponse } from "./approval-payload.js";

/**
 * ATO-1474: a per-site session grant (browser submits, ATO-1181; HTTP
 * origins, ATO-1182) over the sidecar. `approval_request` names the site
 * as `grantHost`; `approval_response` may echo it back, and a value that
 * is not the request's own site fails the request, leaving it pending.
 */
describe("sidecar per-site session grants (ATO-1474)", () => {
  function setup() {
    const pending: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ level: 1, emit: (r) => pending.push(r) });
    return { pending, gate };
  }

  const submit = (host: string): Omit<ApprovalRequest, "approvalId"> => ({
    sessionId: "s",
    tool: "browser.click",
    category: "browser_commit",
    reason: `submit a form on ${host}`,
    affectedResources: [host],
  });

  const post = (origin: string): Omit<ApprovalRequest, "approvalId"> => ({
    sessionId: "s",
    tool: "os.http.request",
    category: "http",
    reason: `POST ${origin}/x`,
    grantKey: origin,
  });

  it("names the site a browser submit's session grant covers", () => {
    const payload = approvalRequestPayload(
      { approvalId: "a1", ...submit("Shop.Example.") },
      undefined,
    );
    expect(payload).toMatchObject({ canSession: true, grantHost: "shop.example" });
  });

  it("names the origin an HTTP request's session grant covers", () => {
    const payload = approvalRequestPayload(
      { approvalId: "a2", ...post("https://api.example.com") },
      undefined,
    );
    expect(payload).toMatchObject({ canSession: true, grantHost: "https://api.example.com" });
  });

  it("a whole-category grant, or none, names no site", () => {
    const shell = approvalRequestPayload(
      { approvalId: "a3", sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r" },
      undefined,
    );
    expect(shell.canSession).toBe(true);
    expect(shell.grantHost).toBeUndefined();
    // Two hosts: no session grant is offered, so no site either.
    const twoHosts = approvalRequestPayload(
      { approvalId: "a4", ...submit("a.example"), affectedResources: ["a.example", "b.example"] },
      undefined,
    );
    expect(twoHosts).toMatchObject({ canSession: false });
    expect(twoHosts.grantHost).toBeUndefined();
  });

  it("a session grant echoing the site covers that site, not another", async () => {
    const { pending, gate } = setup();
    const first = gate.request(submit("shop.example"));
    expect(
      resolveApprovalResponse(
        { approvalId: pending[0]!.approvalId, approved: true, grant: "session", grantHost: "SHOP.example" },
        gate,
      ),
    ).toBe(true);
    await expect(first).resolves.toMatchObject({ approved: true });
    expect(gate.sessionGrants("s").sites).toEqual([
      { category: "browser_commit", host: "shop.example" },
    ]);
    expect(gate.sessionGrants("s").categories).toEqual([]);

    // Same site: silent.
    await expect(gate.request(submit("shop.example"))).resolves.toMatchObject({ approved: true });
    expect(pending).toHaveLength(1);
    // Another site, or a subdomain: asks again.
    void gate.request(submit("evil.example"));
    void gate.request(submit("mail.shop.example"));
    expect(pending).toHaveLength(3);
  });

  it("without grantHost a session grant behaves as before: per site, from the request", async () => {
    const { pending, gate } = setup();
    const first = gate.request(submit("shop.example"));
    resolveApprovalResponse({ approvalId: pending[0]!.approvalId, approved: true, grant: "session" }, gate);
    await first;
    expect(gate.sessionGrants("s").sites).toEqual([
      { category: "browser_commit", host: "shop.example" },
    ]);
    void gate.request(submit("other.example"));
    expect(pending).toHaveLength(2);
  });

  it("an HTTP origin grant echoed back covers that origin only", async () => {
    const { pending, gate } = setup();
    const first = gate.request(post("https://a.example"));
    resolveApprovalResponse(
      { approvalId: pending[0]!.approvalId, approved: true, grant: "session", grantHost: "https://a.example/" },
      gate,
    );
    await first;
    await expect(gate.request(post("https://a.example"))).resolves.toMatchObject({ approved: true });
    expect(pending).toHaveLength(1);
    void gate.request(post("https://b.example"));
    expect(pending).toHaveLength(2);
  });

  it("a grantHost for another site fails and leaves the request pending, granting nothing", () => {
    const { pending, gate } = setup();
    void gate.request(submit("shop.example"));
    const id = pending[0]!.approvalId;
    for (const grantHost of ["evil.example", "example", "mail.shop.example", "https://shop.example"]) {
      expect(() =>
        resolveApprovalResponse({ approvalId: id, approved: true, grant: "session", grantHost }, gate),
      ).toThrow(/still pending/);
    }
    expect(gate.isPending(id)).toBe(true);
    expect(gate.sessionGrants("s")).toEqual({ categories: [], shapes: [] });
  });

  it("a grantHost that is not a string, or on a grant that is not per site, fails", () => {
    const { pending, gate } = setup();
    void gate.request(submit("shop.example"));
    const id = pending[0]!.approvalId;
    const bad = [
      { grant: "session", grantHost: 42 },
      { grant: "session", grantHost: "  " },
      // Only a session grant is per site.
      { grant: "always", grantHost: "shop.example" },
      // A grantHost without a grant is not an "allow once".
      { grantHost: "shop.example" },
    ];
    for (const extra of bad) {
      expect(() =>
        resolveApprovalResponse(
          { approvalId: id, approved: true, ...(extra as object) } as Parameters<typeof resolveApprovalResponse>[0],
          gate,
        ),
      ).toThrow(/still pending/);
    }
    expect(gate.isPending(id)).toBe(true);

    // A whole-category request cannot be narrowed to a "site" by the host.
    void gate.request({ sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r" });
    const shellId = pending[1]!.approvalId;
    expect(() =>
      resolveApprovalResponse(
        { approvalId: shellId, approved: true, grant: "session", grantHost: "shop.example" },
        gate,
      ),
    ).toThrow(/still pending/);
    expect(gate.isPending(shellId)).toBe(true);
  });

  it("a deny ignores grantHost", async () => {
    const { pending, gate } = setup();
    const first = gate.request(submit("shop.example"));
    resolveApprovalResponse(
      { approvalId: pending[0]!.approvalId, approved: false, grantHost: "evil.example" },
      gate,
    );
    await expect(first).resolves.toMatchObject({ approved: false });
  });
});
