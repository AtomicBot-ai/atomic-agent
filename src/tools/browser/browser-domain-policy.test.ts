import { describe, expect, it } from "vitest";
import {
  checkBrowserUrl,
  hostMatchesAny,
  hostMatchesDomain,
  normalizeDomainEntry,
  webHostOf,
} from "./browser-domain-policy.js";

describe("normalizeDomainEntry", () => {
  it.each([
    ["example.com", "example.com"],
    ["  Example.COM  ", "example.com"],
    ["https://example.com/path?q=1#x", "example.com"],
    ["http://user:pw@example.com:8080/", "example.com"],
    ["*.example.com", "example.com"],
    [".example.com", "example.com"],
    ["example.com.", "example.com"],
    ["example.com:443", "example.com"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeDomainEntry(raw)).toBe(expected);
  });

  it("returns null for an entry with nothing left", () => {
    expect(normalizeDomainEntry("")).toBeNull();
    expect(normalizeDomainEntry("https://")).toBeNull();
    expect(normalizeDomainEntry("*.")).toBeNull();
  });
});

describe("host matching", () => {
  it("matches the host itself and its subdomains, case-insensitively", () => {
    expect(hostMatchesDomain("example.com", "example.com")).toBe(true);
    expect(hostMatchesDomain("WWW.Example.com", "example.com")).toBe(true);
    expect(hostMatchesDomain("a.b.example.com", "example.com")).toBe(true);
    expect(hostMatchesDomain("example.com.", "example.com")).toBe(true);
  });

  it("does not match a lookalike that only ends with the same letters", () => {
    expect(hostMatchesDomain("notexample.com", "example.com")).toBe(false);
    expect(hostMatchesDomain("example.com.evil.net", "example.com")).toBe(false);
  });

  it("normalises raw list entries before matching", () => {
    expect(hostMatchesAny("mail.google.com", ["https://*.google.com/"])).toBe(true);
    expect(hostMatchesAny("mail.google.com", ["", "bing.com"])).toBe(false);
  });
});

describe("webHostOf", () => {
  it("reads http(s) hosts only", () => {
    expect(webHostOf("https://Docs.Example.com/x")).toBe("docs.example.com");
    expect(webHostOf("file:///etc/passwd")).toBeNull();
    expect(webHostOf("javascript:alert(1)")).toBeNull();
    expect(webHostOf("not a url")).toBeNull();
  });
});

describe("checkBrowserUrl", () => {
  const policy = { blockedDomains: ["bank.example"], allowedDomains: [] };

  it("blocks a listed host and its subdomains", () => {
    expect(checkBrowserUrl("https://bank.example/login", policy)).toEqual({ kind: "blocked", host: "bank.example" });
    expect(checkBrowserUrl("https://www.bank.example/", policy).kind).toBe("blocked");
    expect(checkBrowserUrl("https://example.com/", policy).kind).toBe("ok");
  });

  it("with an empty allow-list nothing is off-site", () => {
    expect(checkBrowserUrl("https://anything.test/", policy).kind).toBe("ok");
  });

  it("with a non-empty allow-list other hosts are off-site, listed ones are ok", () => {
    const allow = { blockedDomains: [], allowedDomains: ["github.com"] };
    expect(checkBrowserUrl("https://gist.github.com/x", allow).kind).toBe("ok");
    expect(checkBrowserUrl("https://example.com/", allow)).toEqual({ kind: "offsite", host: "example.com" });
  });

  it("blocked wins over allowed", () => {
    const both = { blockedDomains: ["evil.github.com"], allowedDomains: ["github.com"] };
    expect(checkBrowserUrl("https://evil.github.com/", both).kind).toBe("blocked");
  });

  it("leaves non-web URLs to the browser_nonweb gate", () => {
    expect(checkBrowserUrl("file:///etc/hosts", policy)).toEqual({ kind: "ok", host: null });
  });

  it("an allow-list of only empty entries gates nothing", () => {
    expect(checkBrowserUrl("https://example.com/", { blockedDomains: [], allowedDomains: ["*."] }).kind).toBe("ok");
  });
});
