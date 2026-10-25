import { describe, expect, it } from "vitest";

import { describeCatalogFetchError } from "./catalog-refresh-result.js";

describe("describeCatalogFetchError", () => {
  it("names the timeout with its length", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(describeCatalogFetchError(err, 20_000)).toBe("timed out after 20 s");
  });

  it("says the body was not JSON", () => {
    let err: unknown;
    try {
      JSON.parse("<html>");
    } catch (e) {
      err = e;
    }
    expect(describeCatalogFetchError(err, 20_000)).toMatch(/^response is not JSON: /);
  });

  it("names the network error code fetch puts on its cause", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    expect(describeCatalogFetchError(err, 20_000)).toBe("network error ENOTFOUND");
  });

  it("falls back to the message, or the value itself", () => {
    expect(describeCatalogFetchError(new Error("boom"), 20_000)).toBe("boom");
    expect(describeCatalogFetchError("nope", 20_000)).toBe("nope");
  });
});
