import { describe, expect, it } from "vitest";
import { registrableDomain, startMoveAllowed } from "./crawl-scope.js";

const move = (a: string, b: string) => startMoveAllowed(new URL(a), new URL(b)).ok;

describe("registrableDomain", () => {
  it("takes the last two labels, three under a country second level", () => {
    expect(registrableDomain("docs.example.com")).toBe("example.com");
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("example.io")).toBe("example.io");
  });

  it("treats shared hosting suffixes and IPs as no site", () => {
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("docs.alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("github.io")).toBeNull();
    expect(registrableDomain("co.uk")).toBeNull();
    expect(registrableDomain("93.184.216.34")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
  });
});

describe("startMoveAllowed", () => {
  it("allows scheme changes, www and apex, and subdomains of one site", () => {
    expect(move("http://example.com/", "https://example.com/")).toBe(true);
    expect(move("https://example.com/", "https://www.example.com/")).toBe(true);
    expect(move("https://www.example.com/", "https://example.com/")).toBe(true);
    expect(move("https://example.com/docs", "https://docs.example.com/")).toBe(true);
    expect(move("https://bbc.co.uk/", "https://www.bbc.co.uk/news")).toBe(true);
  });

  it("refuses another site, another user's shared-host site, and another IP", () => {
    expect(move("https://example.com/", "https://other.org/")).toBe(false);
    expect(move("https://alice.github.io/", "https://bob.github.io/")).toBe(false);
    expect(move("https://a.co.uk/", "https://b.co.uk/")).toBe(false);
    expect(move("http://93.184.216.34/", "http://93.184.216.35/")).toBe(false);
  });
});
