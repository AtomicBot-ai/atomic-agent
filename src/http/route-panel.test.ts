import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("GET /panel (ATO-1128)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({ apiKey: "panel-test-key-0123456789" });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("serves the page and its script without a key, under a strict CSP", async () => {
    const page = await fetch(`${harness.baseUrl}/panel`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain('src="/panel/app.js"');
    const js = await fetch(`${harness.baseUrl}/panel/app.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("/api/sessions");
  });

  it("the data behind it still needs the key", async () => {
    expect((await fetch(`${harness.baseUrl}/api/sessions`)).status).toBe(401);
  });
});
