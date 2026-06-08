import { describe, it, expect } from "vitest";
import {
  assertHostAllowed,
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
    expect(pinned).toBe("93.184.216.34");
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
