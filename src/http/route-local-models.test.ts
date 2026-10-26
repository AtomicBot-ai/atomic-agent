import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("GET /api/local-models/* (ATO-1127)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness({ apiKey: "local-models-key-0123456789" }); });
  afterEach(async () => { await harness.cleanup(); });

  const get = (path: string, key = "local-models-key-0123456789") =>
    fetch(`${harness.baseUrl}${path}`, { headers: { authorization: `Bearer ${key}` } });

  it("answers the text `models list` prints, with the catalog in it", async () => {
    const res = await get("/api/local-models/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; text: string };
    expect(body.ok).toBe(true);
    expect(body.text).toMatch(/^ID\s+\| FAMILY/);
    expect(body.text).toContain("qwen-3.5-4b");
  });

  it("answers the text `models status` prints", async () => {
    const body = (await (await get("/api/local-models/status")).json()) as { text: string };
    expect(body.text).toMatch(/^mode:/);
  });

  it("needs the key", async () => {
    expect((await get("/api/local-models/list", "wrong")).status).toBe(401);
  });
});
