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

  it("drops the remembered stance when the configured base moves under it", async () => {
    // `snapshot` recomputes baseLevel from the config on every read, so a
    // stance remembered against the old base would be reported against a
    // base that no longer resolves to it. Held against base 5, `default`
    // means level 5; re-read against base 1 it would claim mode `default`
    // / baseLevel 1 / approvalLevel 5, which resolveCodingMode never
    // produces. The stance is dropped and the seed answers instead.
    harness = await startTestHarness({ approvalLevel: 5 });
    const configFile = join(harness.stateDir, "config.json");
    const writeBase = (approvalLevel: number) => {
      writeFileSync(
        configFile,
        JSON.stringify(
          { ...USER_CONFIG_DEFAULTS, agent: { ...USER_CONFIG_DEFAULTS.agent, approvalLevel } },
          null,
          2,
        ),
        "utf8",
      );
      resetConfigCache();
    };

    writeBase(5);
    const posted = await setMode(harness.baseUrl, "default");
    expect(posted.json.mode).toBe("default");
    expect(posted.json.baseLevel).toBe(5);
    expect(posted.json.approvalLevel).toBe(5);

    writeBase(1);
    const after = await getMode(harness.baseUrl);
    expect(after.json.baseLevel).toBe(1);
    // The live ladder is still at 5 — nothing moved it — so the seed says
    // `bypass`, and resolveCodingMode("bypass", 1) really is level 5 with
    // plan off. Reply and base agree again.
    expect(after.json.mode).toBe("bypass");
    const consistent = resolveCodingMode(after.json.mode, after.json.baseLevel);
    expect(after.json.approvalLevel).toBe(consistent.approvalLevel);
    expect(after.json.planMode).toBe(consistent.planMode);
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
