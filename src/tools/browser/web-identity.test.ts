import { afterEach, describe, expect, it } from "vitest";
import {
  FALLBACK_CHROME_MAJOR,
  acceptLanguageFor,
  buildUserAgent,
  buildWebIdentity,
  getWebIdentity,
  normalizeLocale,
  platformToken,
  resetWebIdentityForTests,
} from "./web-identity.js";

describe("web identity (ATO-969)", () => {
  afterEach(() => resetWebIdentityForTests());

  it("uses Chrome's frozen reduced-UA OS token per platform", () => {
    expect(platformToken("darwin")).toBe("Macintosh; Intel Mac OS X 10_15_7");
    expect(platformToken("win32")).toBe("Windows NT 10.0; Win64; x64");
    expect(platformToken("linux")).toBe("X11; Linux x86_64");
  });

  it("builds the reduced UA from the installed major version", () => {
    expect(buildUserAgent({ platform: "win32", chromeMajor: 142 })).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    );
  });

  it("adds Edge's own token when the browser is Edge", () => {
    expect(buildUserAgent({ platform: "darwin", chromeMajor: 141, kind: "edge" })).toMatch(
      / Chrome\/141\.0\.0\.0 Safari\/537\.36 Edg\/141\.0\.0\.0$/,
    );
  });

  it("falls back to one central version and says so", () => {
    const id = buildWebIdentity({ platform: "linux", locale: "en-US", chromeMajor: null });
    expect(id.versionKnown).toBe(false);
    expect(id.chromeMajor).toBe(FALLBACK_CHROME_MAJOR);
    expect(id.userAgent).toContain(`Chrome/${FALLBACK_CHROME_MAJOR}.0.0.0`);
    expect(id.userAgent).not.toContain("Headless");
  });

  it("normalizes system locales", () => {
    expect(normalizeLocale("ru-RU-u-ca-gregory")).toBe("ru-RU");
    expect(normalizeLocale("de_DE.UTF-8")).toBe("de-DE");
    expect(normalizeLocale("fr")).toBe("fr");
    expect(normalizeLocale("C")).toBe("en-US");
    expect(normalizeLocale(undefined)).toBe("en-US");
    expect(normalizeLocale("und")).toBe("en-US");
  });

  it("turns the locale into the Accept-Language Chrome sends", () => {
    expect(acceptLanguageFor("en-US")).toBe("en-US,en;q=0.9");
    expect(acceptLanguageFor("en")).toBe("en-US,en;q=0.9");
    expect(acceptLanguageFor("en-GB")).toBe("en-GB,en;q=0.9");
    expect(acceptLanguageFor("ru-RU")).toBe("ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7");
    expect(acceptLanguageFor("de")).toBe("de,en-US;q=0.9,en;q=0.8");
  });

  it("never rotates: every call returns the same identity", () => {
    const first = getWebIdentity();
    for (let i = 0; i < 5; i += 1) expect(getWebIdentity()).toBe(first);
    expect(first.acceptLanguage.startsWith(first.locale)).toBe(true);
  });
});
