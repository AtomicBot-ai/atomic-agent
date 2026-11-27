import { describe, expect, it } from "vitest";

import { assertHostAllowed, isBlockedIp, parseHttpUrl, SsrfBlockedError } from "./web-fetch-ssrf-guard.js";

/**
 * ATO-2703: IPv6 forms that carry an IPv4 address are re-checked, so a
 * guest's `os.web.fetch` cannot reach loopback, the LAN or the cloud
 * metadata address through them. Public addresses in the same forms
 * stay allowed.
 */
describe("SSRF guard: IPv6 with an embedded IPv4", () => {
  it("blocks private IPv4 inside compatible, translated, NAT64 and 6to4 forms", () => {
    for (const ip of [
      "::127.0.0.1", // IPv4-compatible
      "::7f00:1",
      "::ffff:0:127.0.0.1", // IPv4-translated
      "64:ff9b::127.0.0.1", // NAT64
      "64:ff9b::a9fe:a9fe", // NAT64 to 169.254.169.254
      "64:ff9b::c0a8:101", // NAT64 to 192.168.1.1
      "2002:7f00:1::", // 6to4 of 127.0.0.1
      "2002:c0a8:101::1", // 6to4 of 192.168.1.1
      "64:ff9b:1::1", // NAT64 local-use
      "fec0::1", // site-local
      "100::1", // discard-only
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("still allows public IPv4 in the same forms and ordinary public IPv6", () => {
    for (const ip of ["64:ff9b::808:808", "2002:808:808::1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("refuses those literals in a URL and a host that resolves to one", async () => {
    await expect(assertHostAllowed(parseHttpUrl("http://[::127.0.0.1]:8080/"))).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertHostAllowed(parseHttpUrl("http://[64:ff9b::7f00:1]/"))).rejects.toBeInstanceOf(SsrfBlockedError);
    const rebinding = async () => [{ address: "2002:7f00:1::", family: 6 }];
    await expect(assertHostAllowed(parseHttpUrl("https://evil.example/"), { lookup: rebinding })).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("keeps refusing the plain local forms", async () => {
    for (const url of ["http://localhost:3000/", "http://127.1/", "http://0x7f000001/", "http://2130706433/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0:8080/"]) {
      const lookup = async () => [{ address: "127.0.0.1", family: 4 }];
      await expect(assertHostAllowed(parseHttpUrl(url), { lookup }), url).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });
});
