import { describe, expect, it } from "vitest";
import {
  ApprovalGate,
  canGrantCategory,
  describeCategoryGrant,
  type ApprovalRequest,
} from "./approval-gate.js";
import { canGrantAlways } from "./approval-rules.js";
import { siteGrantHost } from "./site-grants.js";

/**
 * ATO-1181: "allow in this chat" on a browser submit or an off-site
 * page covers that one site, not every site.
 */

/** A gate whose operator answers every prompt with `[s]`, counting prompts. */
function grantingGate() {
  const prompts: ApprovalRequest[] = [];
  const gate = new ApprovalGate({
    emit: (req) => {
      prompts.push(req);
      setImmediate(() =>
        gate.resolve({ approvalId: req.approvalId, approved: true, grant: "category" }),
      );
    },
  });
  return { gate, prompts };
}

function click(host: string | null, category: "browser_commit" | "browser_offsite" = "browser_commit") {
  return {
    sessionId: "s",
    tool: "browser.click",
    category,
    reason: "submit control",
    ...(host !== null ? { affectedResources: [host] } : {}),
  } as const;
}

describe("per-site browser grants", () => {
  it("a submit grant on site A covers A again, but site B asks", async () => {
    const { gate, prompts } = grantingGate();
    await gate.request(click("shop.example"));
    expect(prompts).toHaveLength(1);

    const again = await gate.request(click("shop.example"));
    expect(again.approved).toBe(true);
    expect(again.reason).toBe("auto-approved (session grant: shop.example)");
    expect(prompts).toHaveLength(1);

    await gate.request(click("evil.example"));
    expect(prompts).toHaveLength(2);
  });

  it("a subdomain is a separate site, and so is the parent domain", async () => {
    const { gate, prompts } = grantingGate();
    await gate.request(click("example.com"));
    await gate.request(click("mail.example.com"));
    await gate.request(click("example.com.evil.test"));
    expect(prompts).toHaveLength(3);
  });

  it("host case and a trailing dot do not make a new site", async () => {
    const { gate, prompts } = grantingGate();
    await gate.request(click("Shop.Example"));
    await gate.request(click("shop.example."));
    expect(prompts).toHaveLength(1);
  });

  it("a submit grant does not cover off-site pages on the same host, nor the reverse", async () => {
    const { gate, prompts } = grantingGate();
    await gate.request(click("shop.example", "browser_commit"));
    await gate.request(click("shop.example", "browser_offsite"));
    expect(prompts).toHaveLength(2);
    await gate.request(click("shop.example", "browser_offsite"));
    expect(prompts).toHaveLength(2);
  });

  it("grants stay inside the session that made them", async () => {
    const { gate, prompts } = grantingGate();
    await gate.request(click("shop.example"));
    await gate.request({ ...click("shop.example"), sessionId: "other" });
    expect(prompts).toHaveLength(2);
  });

  it("a request naming no host is never granted, and [s] is not offered", async () => {
    const { gate, prompts } = grantingGate();
    const noHost = click(null);
    expect(canGrantCategory({ approvalId: "x", ...noHost })).toBe(false);
    await gate.request(noHost);
    await gate.request(noHost);
    expect(prompts).toHaveLength(2);
    // Nor does a host-less grant attempt leak into a hosted request.
    await gate.request(click("shop.example"));
    expect(prompts).toHaveLength(3);
  });

  it("the snapshot lists site grants, and clearing the session drops them", async () => {
    const { gate } = grantingGate();
    await gate.request(click("shop.example"));
    expect(gate.sessionGrants("s")).toEqual({
      categories: [],
      shapes: [],
      sites: [{ category: "browser_commit", host: "shop.example" }],
    });
    gate.clearSessionGrants("s");
    expect(gate.sessionGrants("s")).toEqual({ categories: [], shapes: [] });
  });

  it("other categories keep their whole-category grant", async () => {
    const { gate, prompts } = grantingGate();
    const http = { sessionId: "s", tool: "http.fetch", category: "http" as const, reason: "r", affectedResources: ["a.example"] };
    await gate.request(http);
    await gate.request({ ...http, affectedResources: ["b.example"] });
    expect(prompts).toHaveLength(1);
  });

  it("the prompt names the site; 'always' is not offered for browser submits", () => {
    const request = { approvalId: "x", workdir: "/tmp/p", ...click("shop.example") };
    expect(describeCategoryGrant(request)).toContain("on shop.example");
    expect(canGrantAlways(request)).toBe(false);
  });

  it("siteGrantHost needs exactly one host", () => {
    expect(siteGrantHost({ category: "browser_commit", affectedResources: ["a.example", "b.example"] })).toBeNull();
    expect(siteGrantHost({ category: "browser_commit", affectedResources: [""] })).toBeNull();
    expect(siteGrantHost({ category: "shell", affectedResources: ["a.example"] })).toBeNull();
  });
});
