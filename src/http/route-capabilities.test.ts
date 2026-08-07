import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("GET /api/capabilities", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("reports the LIVE approval-gate state, not the boot snapshot", async () => {
    // The harness boots with approvalRequired: false while the persisted
    // config default is true. A frozen `runtime.config` snapshot would
    // report the config value; the route must report the gate.
    harness = await startTestHarness({ approvalRequired: false });

    const before = await fetchCapabilities(harness.baseUrl);
    expect(before.agent.approvalRequired).toBe(false);

    harness.runtime.setApprovalRequired(true);
    const after = await fetchCapabilities(harness.baseUrl);
    expect(after.agent.approvalRequired).toBe(true);

    harness.runtime.setApprovalRequired(false);
    const reverted = await fetchCapabilities(harness.baseUrl);
    expect(reverted.agent.approvalRequired).toBe(false);
  });
});

async function fetchCapabilities(
  baseUrl: string,
): Promise<{ agent: { approvalRequired: boolean } }> {
  const res = await fetch(`${baseUrl}/api/capabilities`);
  expect(res.status).toBe(200);
  return (await res.json()) as { agent: { approvalRequired: boolean } };
}
