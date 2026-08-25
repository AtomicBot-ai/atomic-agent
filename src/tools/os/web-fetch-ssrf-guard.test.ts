import { describe, it, expect } from "vitest";
import {
  assertHostAllowed,
  formatResolveEntry,
  isBlockedIp,
  parseHttpUrl,
  SsrfBlockedError,
  type HostLookup,
} from "./web-fetch-ssrf-guard.js";

describe("isBlockedIp", () => {
  it("blocks IPv4 private / internal / reserved ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.5",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4 addresses", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback / link-local / unique-local / mapped-v4", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::3", "::ffff:127.0.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6 addresses", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("parseHttpUrl", () => {
  it("accepts http and https", () => {
    expect(parseHttpUrl("https://example.com/x").hostname).toBe("example.com");
    expect(parseHttpUrl("http://example.com").protocol).toBe("http:");
  });

  it("rejects non-http(s) schemes", () => {
    for (const raw of ["ftp://x/y", "file:///etc/passwd", "gopher://x"]) {
      expect(() => parseHttpUrl(raw)).toThrow(SsrfBlockedError);
    }
  });

  it("rejects malformed URLs", () => {
    expect(() => parseHttpUrl("not a url")).toThrow(SsrfBlockedError);
  });
});

describe("assertHostAllowed", () => {
  const lookupTo =
    (...addresses: string[]): HostLookup =>
    async () =>
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));

  it("returns a pinned address when all resolved addresses are public", async () => {
    const pinned = await assertHostAllowed(parseHttpUrl("https://example.com"), {
      lookup: lookupTo("93.184.216.34"),
    });
    expect(pinned).toEqual(["93.184.216.34"]);
  });

  /**
   * The guard used to return `addresses[0]`, which turned every
   * multi-homed host into a single-address host: one blackholed CDN
   * edge, or an AAAA record sorting first on a machine with no IPv6
   * route, and the fetch failed on a site every other client could
   * open. Handing over the whole list is safe precisely because the
   * check above is all-or-nothing — a set that survives it is a set
   * curl may try in any order.
   */
  it("returns every safe address, in resolver order", async () => {
    const pinned = await assertHostAllowed(parseHttpUrl("https://example.com"), {
      lookup: lookupTo("2606:2800:220:1::1", "93.184.216.34", "93.184.216.35"),
    });
    expect(pinned).toEqual([
      "2606:2800:220:1::1",
      "93.184.216.34",
      "93.184.216.35",
    ]);
  });

  it("still refuses the whole set when one address is private", async () => {
    await expect(
      assertHostAllowed(parseHttpUrl("https://evil.example"), {
        lookup: lookupTo("93.184.216.34", "93.184.216.35", "127.0.0.1"),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  describe("formatResolveEntry", () => {
    it("joins the list the way curl reads it", () => {
      expect(
        formatResolveEntry("example.com", "443", [
          "93.184.216.34",
          "93.184.216.35",
        ]),
      ).toBe("example.com:443:93.184.216.34,93.184.216.35");
    });

    it("brackets each IPv6 literal individually", () => {
      expect(
        formatResolveEntry("example.com", "443", [
          "2606:2800:220:1::1",
          "93.184.216.34",
        ]),
      ).toBe("example.com:443:[2606:2800:220:1::1],93.184.216.34");
    });
  });

  it("throws when any resolved address is private (rebinding defense)", async () => {
    await expect(
      assertHostAllowed(parseHttpUrl("https://evil.example"), {
        lookup: lookupTo("93.184.216.34", "10.0.0.5"),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws when DNS resolves to nothing", async () => {
    await expect(
      assertHostAllowed(parseHttpUrl("https://void.example"), {
        lookup: lookupTo(),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws when DNS lookup itself fails", async () => {
    const failing: HostLookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      assertHostAllowed(parseHttpUrl("https://nx.example"), { lookup: failing }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
