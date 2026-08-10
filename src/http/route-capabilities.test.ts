import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("GET /api/capabilities", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("reports the LIVE approval level, not the boot snapshot", async () => {
    // The harness boots at level 5 while the persisted config default
    // is 1. A frozen `runtime.config` snapshot would report the config
    // value; the route must report the gate.
    harness = await startTestHarness({ approvalLevel: 5 });

    const before = await fetchCapabilities(harness.baseUrl);
    expect(before.agent.approvalLevel).toBe(5);

    harness.runtime.setApprovalLevel(2);
    const after = await fetchCapabilities(harness.baseUrl);
    expect(after.agent.approvalLevel).toBe(2);

    harness.runtime.setApprovalLevel(5);
    const reverted = await fetchCapabilities(harness.baseUrl);
    expect(reverted.agent.approvalLevel).toBe(5);
  });

  it("derives the compatibility approvalRequired flag from the level", async () => {
    // Clients written against the binary toggle keep working: `true`
    // while any category still prompts (level < 5), `false` only at 5.
    harness = await startTestHarness({ approvalLevel: 5 });

    expect((await fetchCapabilities(harness.baseUrl)).agent.approvalRequired).toBe(
      false,
    );
    harness.runtime.setApprovalLevel(4);
    expect((await fetchCapabilities(harness.baseUrl)).agent.approvalRequired).toBe(
      true,
    );
    harness.runtime.setApprovalLevel(1);
    expect((await fetchCapabilities(harness.baseUrl)).agent.approvalRequired).toBe(
      true,
    );
  });
});

async function fetchCapabilities(
  baseUrl: string,
): Promise<{ agent: { approvalLevel: number; approvalRequired: boolean } }> {
  const res = await fetch(`${baseUrl}/api/capabilities`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    agent: { approvalLevel: number; approvalRequired: boolean };
  };
}
