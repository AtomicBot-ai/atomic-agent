import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// playwright-core requires chromium-bidi by its old CommonJS paths (lib/server/bidi/bidiOverCdp.js),
// and scripts/bundle-sea.ts bundles it from there. chromium-bidi 157 and later moved to an ES module
// under out/Default/gen/, so bumping it to clear the zod advisory would break the browser tools.
// ATO-1415 keeps chromium-bidi 15 and overrides zod to 4 (package.json "overrides") instead; this
// pins both halves of that choice.
const require = createRequire(import.meta.url);

describe("chromium-bidi as playwright-core loads it", () => {
  it("still resolves at the CommonJS paths playwright-core requires", () => {
    expect(() => require.resolve("chromium-bidi/lib/cjs/bidiMapper/BidiMapper")).not.toThrow();
    expect(() => require.resolve("chromium-bidi/lib/cjs/cdp/CdpConnection")).not.toThrow();
  });

  it("loads its protocol schemas on the overridden zod 4", () => {
    const zod = require("zod/package.json") as { version: string };
    expect(Number(zod.version.split(".")[0])).toBeGreaterThanOrEqual(4);
    expect(() => require("chromium-bidi/lib/cjs/bidiMapper/BidiMapper")).not.toThrow();
    expect(() => require("chromium-bidi/lib/cjs/protocol-parser/protocol-parser")).not.toThrow();
  });
});
