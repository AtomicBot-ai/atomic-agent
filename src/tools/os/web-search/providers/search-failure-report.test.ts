import { describe, expect, it } from "vitest";

import {
  buildUnavailableMessage,
  describeFailure,
  isConnectFailure,
} from "./search-failure-report.js";
import { WebSearchRateLimitedError } from "../web-search-errors.js";

/**
 * The user saw `curl: (28) Connection timed out after 15005 milliseconds`
 * and nothing else (ATO-315). Each curl exit that means "never reached
 * the host" has to come out as words, with the raw line kept after them.
 */
describe("describeFailure", () => {
  const cases: [string, string][] = [
    [
      "curl: (6) Could not resolve host: html.duckduckgo.com",
      "could not connect, the site's name could not be looked up (DNS)",
    ],
    [
      "DNS resolution failed for html.duckduckgo.com: getaddrinfo ENOTFOUND",
      "could not connect, the site's name could not be looked up (DNS)",
    ],
    [
      "curl: (28) Resolving timed out after 5000 milliseconds",
      "could not connect, the site's name could not be looked up (DNS)",
    ],
    [
      "curl: (7) Failed to connect to html.duckduckgo.com port 443 after 12 ms: Connection refused",
      "could not connect, the connection was refused",
    ],
    [
      "curl: (7) Failed to connect to html.duckduckgo.com port 443 after 3 ms: Network is unreachable",
      "could not connect, the network could not reach the site",
    ],
    [
      "curl: (7) Failed to connect to html.duckduckgo.com port 443 after 3 ms: No route to host",
      "could not connect, the network could not reach the site",
    ],
    [
      "curl: (7) Failed to connect to html.duckduckgo.com port 443 after 12 ms: Couldn't connect to server",
      "could not connect, the connection failed",
    ],
    [
      "curl: (28) Connection timed out after 5002 milliseconds",
      "could not connect, the connection timed out after 5 s",
    ],
    [
      "curl: (28) Failed to connect to mcp.exa.ai port 443 after 5001 ms: Timeout was reached",
      "could not connect, the connection timed out after 5 s",
    ],
    [
      "curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to html.duckduckgo.com:443",
      "could not connect, the secure connection (TLS) failed",
    ],
  ];

  for (const [raw, words] of cases) {
    it(`explains ${raw.slice(0, 12)}…: ${words}`, () => {
      const err = new Error(raw);
      expect(isConnectFailure(err)).toBe(true);
      expect(describeFailure("duckduckgo", err, false)).toBe(
        `duckduckgo: ${words} (site unreachable from this network); ${raw}`,
      );
    });
  }

  it("tells a slow answer apart from a host that was never reached", () => {
    const raw =
      "curl: (28) Operation timed out after 15001 milliseconds with 0 bytes received";
    const err = new Error(raw);
    expect(isConnectFailure(err)).toBe(false);
    expect(describeFailure("duckduckgo", err, false)).toBe(
      `duckduckgo: timed out (connected, but no answer in 15 s); ${raw}`,
    );
  });

  it("names the free limit only for keyless Exa", () => {
    const err = new WebSearchRateLimitedError("exa", null);
    expect(describeFailure("exa", err, true)).toBe(
      "exa: free limit reached (HTTP 429)",
    );
    expect(describeFailure("exa", err, false)).toBe(
      "exa: rate limited (HTTP 429)",
    );
  });

  it("passes any other message through after the name", () => {
    expect(
      describeFailure("exa", new Error("Exa returned HTTP 403"), false),
    ).toBe("exa: Exa returned HTTP 403");
  });
});

describe("buildUnavailableMessage", () => {
  const failures = [
    "duckduckgo: could not connect, the connection timed out after 5 s (site unreachable from this network); curl: (28) Connection timed out after 5002 milliseconds",
  ];

  it("lists each provider and gives one next action without a key card", () => {
    const message = buildUnavailableMessage({
      failures,
      keyRequired: undefined,
      allUnreachable: true,
    });
    const lines = message.split("\n");
    expect(lines[0]).toBe(
      "Web search is unavailable: no search provider answered.",
    );
    expect(lines[1]).toBe(`- ${failures[0]}`);
    expect(message).toContain("None of the search sites could be reached");
    expect(message).toContain("`web.search.provider`");
    expect(message).toContain("`brave`");
    expect(message).toContain("`searxng`");
    expect(lines.filter((line) => line.startsWith("To fix it:"))).toHaveLength(1);
    expect(lines.at(-1)).toContain("Do not repeat this search");
  });

  it("gives the free Exa key as the one fix when a key would help", () => {
    const message = buildUnavailableMessage({
      failures,
      keyRequired: {
        provider: "exa",
        reason: "unreachable",
        getKeyUrl: "https://dashboard.exa.ai/api-keys",
        envVar: "EXA_API_KEY",
      },
      allUnreachable: true,
    });
    const fix = message
      .split("\n")
      .filter((line) => line.startsWith("To fix it:"));
    expect(fix).toHaveLength(1);
    expect(fix[0]).toContain("https://dashboard.exa.ai/api-keys");
    expect(fix[0]).toContain("EXA_API_KEY=...");
    // One action: no second remedy competing with the key.
    expect(message).not.toContain("`brave`");
    expect(message).not.toContain("`searxng`");
  });
});
