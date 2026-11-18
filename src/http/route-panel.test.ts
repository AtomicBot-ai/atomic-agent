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

  it("can be added to a phone's home screen: manifest, icons, app meta tags (ATO-1130)", async () => {
    const html = await (await fetch(`${harness.baseUrl}/panel`)).text();
    expect(html).toContain('<link rel="manifest" href="/panel/manifest.webmanifest">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/panel/icon-180.png">');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');

    const page = await fetch(`${harness.baseUrl}/panel`);
    expect(page.headers.get("content-security-policy")).toContain("manifest-src 'self'");

    const res = await fetch(`${harness.baseUrl}/panel/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = (await res.json()) as {
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; type: string }>;
    };
    expect(manifest.start_url).toBe("/panel");
    expect(manifest.scope).toBe("/panel");
    expect(manifest.display).toBe("standalone");

    // Every icon the manifest names is served, without a key.
    for (const icon of manifest.icons) {
      const img = await fetch(`${harness.baseUrl}${icon.src}`);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe(icon.type);
    }
  });

  it("serves a real 180x180 PNG for the iOS home-screen icon (ATO-1130)", async () => {
    const res = await fetch(`${harness.baseUrl}/panel/icon-180.png`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR width and height.
    expect(bytes.readUInt32BE(16)).toBe(180);
    expect(bytes.readUInt32BE(20)).toBe(180);
  });

  it("the icon SVG runs no script when opened on its own (ATO-1130)", async () => {
    const res = await fetch(`${harness.baseUrl}/panel/icon.svg`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).not.toContain("<script");
  });

  it("the data behind it still needs the key", async () => {
    expect((await fetch(`${harness.baseUrl}/api/sessions`)).status).toBe(401);
  });
});
