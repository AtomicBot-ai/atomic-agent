import { afterEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { privacyVaultFor, resetPrivacyVaults } from "../privacy/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";

interface ShieldJson {
  enabled: boolean;
  masked: number;
  sessions: number;
  session?: { masked: number; lastRequest: number };
}

async function get(baseUrl: string, query = ""): Promise<{ status: number; json: ShieldJson }> {
  const res = await fetch(`${baseUrl}/api/privacy-shield${query}`);
  return { status: res.status, json: (await res.json()) as ShieldJson };
}

async function post(baseUrl: string, body: unknown): Promise<{ status: number; json: ShieldJson }> {
  const res = await fetch(`${baseUrl}/api/privacy-shield`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ShieldJson };
}

describe("GET/POST /api/privacy-shield (ATO-1082)", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
    resetPrivacyVaults();
  });

  it("is off by default and counts nothing", async () => {
    harness = await startTestHarness();
    const first = await get(harness.baseUrl);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ enabled: false, masked: 0, sessions: 0 });
  });

  it("turns on, persists the key and reports masked counts", async () => {
    harness = await startTestHarness();
    const posted = await post(harness.baseUrl, { enabled: true });
    expect(posted.status).toBe(200);
    expect(posted.json.enabled).toBe(true);
    resetConfigCache();
    expect(getConfig().privacy?.shield.enabled).toBe(true);

    privacyVaultFor("s-1").mask("mail a@b.io");
    const read = await get(harness.baseUrl, "?sessionId=s-1");
    expect(read.json).toMatchObject({ enabled: true, masked: 1, sessions: 1, session: { masked: 1 } });

    const off = await post(harness.baseUrl, { enabled: false });
    expect(off.json.enabled).toBe(false);
  });

  it("refuses a body without a boolean", async () => {
    harness = await startTestHarness();
    const bad = await post(harness.baseUrl, { enabled: "yes" });
    expect(bad.status).toBe(400);
  });
});
