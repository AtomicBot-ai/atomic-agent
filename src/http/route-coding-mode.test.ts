import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS, resetConfigCache } from "../config/index.js";
import { resolveCodingMode, type CodingMode } from "../tui/coding-mode.js";
import { startTestHarness, type Harness } from "./test-harness.js";

interface ModeJson {
  mode: CodingMode;
  approvalLevel: number;
  planMode: boolean;
  baseLevel: number;
  look: { label: string; summary: string };
}

async function getMode(baseUrl: string): Promise<{ status: number; json: ModeJson }> {
  const res = await fetch(`${baseUrl}/api/coding-mode`);
  return { status: res.status, json: (await res.json()) as ModeJson };
}

async function setMode(
  baseUrl: string,
  mode: unknown,
): Promise<{ status: number; json: ModeJson }> {
  const res = await fetch(`${baseUrl}/api/coding-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return { status: res.status, json: (await res.json()) as ModeJson };
}

describe("GET/POST /api/coding-mode", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("round-trips every mode and moves the live runtime", async () => {
    harness = await startTestHarness({ approvalLevel: 1 });
    const base = harness.runtime.config.agent.approvalLevel;

    const first = await getMode(harness.baseUrl);
    expect(first.status).toBe(200);
    expect(first.json.baseLevel).toBe(base);

    for (const mode of ["plan", "auto", "bypass", "default"] as const) {
      const expected = resolveCodingMode(mode, base);
      const posted = await setMode(harness.baseUrl, mode);
      expect(posted.status).toBe(200);
      expect(posted.json.mode).toBe(mode);
      expect(posted.json.approvalLevel).toBe(expected.approvalLevel);
      expect(posted.json.planMode).toBe(expected.planMode);
      // The live switches actually moved, not just the reply.
      expect(harness.runtime.getApprovalLevel()).toBe(expected.approvalLevel);
      expect(harness.runtime.getPlanMode()).toBe(expected.planMode);
      // And a fresh GET reads back the mode that was set.
      const readBack = await getMode(harness.baseUrl);
      expect(readBack.json.mode).toBe(mode);
      expect(readBack.json.approvalLevel).toBe(expected.approvalLevel);
      expect(readBack.json.planMode).toBe(expected.planMode);
    }
  });

  it("holds the chosen stance even when the base level makes modes resolve alike", async () => {
    // The regression guard for a level-5 operator: `resolveCodingMode`
    // is not injective, and at base 5 `default`, `auto` and `bypass` all
    // mean level 5 with plan off. Inferring the mode from the live
    // switches answered "bypass" for all three.
    harness = await startTestHarness({ approvalLevel: 5 });
    writeFileSync(
      join(harness.stateDir, "config.json"),
      JSON.stringify(
        {
          ...USER_CONFIG_DEFAULTS,
          agent: { ...USER_CONFIG_DEFAULTS.agent, approvalLevel: 5 },
        },
        null,
        2,
      ),
      "utf8",
    );
    resetConfigCache();

    const seed = await getMode(harness.baseUrl);
    expect(seed.json.baseLevel).toBe(5);

    for (const mode of ["default", "auto", "bypass", "default"] as const) {
      const posted = await setMode(harness.baseUrl, mode);
      expect(posted.json.mode).toBe(mode);
      expect(posted.json.approvalLevel).toBe(5);
      expect(posted.json.planMode).toBe(false);
      expect((await getMode(harness.baseUrl)).json.mode).toBe(mode);
    }
  });

  it("rejects an unknown mode with 400 and changes nothing", async () => {
    harness = await startTestHarness({ approvalLevel: 1 });
    const before = harness.runtime.getApprovalLevel();
    const res = await fetch(`${harness.baseUrl}/api/coding-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "yolo" }),
    });
    expect(res.status).toBe(400);
    expect(harness.runtime.getApprovalLevel()).toBe(before);
    expect(harness.runtime.getPlanMode()).toBe(false);
  });
});
