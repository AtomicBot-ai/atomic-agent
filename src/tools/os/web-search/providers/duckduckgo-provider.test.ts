import { describe, expect, it } from "vitest";

import {
  createDuckDuckGoProvider,
  isBotChallenge,
  parseDuckDuckGoHtml,
} from "./duckduckgo-provider.js";
import { WebSearchBlockedError } from "../web-search-errors.js";

describe("parseDuckDuckGoHtml", () => {
  it("extracts title, resolved URL, and snippet from html.duckduckgo.com results", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Fdoc">Example Doc</a>
        <a class="result__snippet">A useful result snippet.</a>
      </div>
    `;

    expect(parseDuckDuckGoHtml(html, 5)).toEqual([
      {
        title: "Example Doc",
        url: "https://example.com/doc",
        snippet: "A useful result snippet.",
      },
    ]);
  });
});

describe("isBotChallenge", () => {
  it("flags a page with a challenge marker and no result anchors", () => {
    expect(isBotChallenge('<form class="challenge-form"></form>')).toBe(true);
    expect(isBotChallenge("<div>are you a human?</div>")).toBe(true);
    expect(isBotChallenge('<div class="g-recaptcha"></div>')).toBe(true);
  });

  it("does NOT flag a genuine zero-result page", () => {
    expect(isBotChallenge("<div>No results found.</div>")).toBe(false);
  });

  it("does NOT flag a page that contains result anchors", () => {
    expect(
      isBotChallenge('<a class="result__a">x</a> challenge-form anomaly'),
    ).toBe(false);
  });
});

describe("createDuckDuckGoProvider", () => {
  const baseOptions = {
    query: "q",
    maxResults: 5,
    timeoutMs: 1000,
    cwd: "/tmp",
    signal: new AbortController().signal,
  };

  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

  function runCommandReturning(html: string) {
    return (async () => ({
      command: "curl",
      args: [],
      exitCode: 0,
      signal: null,
      stdout: stubCurlStdout(html),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    })) as never;
  }

  it("throws WebSearchBlockedError on a blocked empty page", async () => {
    const provider = createDuckDuckGoProvider({
      runCommand: runCommandReturning('<form class="challenge-form"></form>'),
      lookup: publicLookup,
    });
    await expect(provider.search(baseOptions)).rejects.toBeInstanceOf(
      WebSearchBlockedError,
    );
  });

  it("returns [] on a genuine empty page (not blocked)", async () => {
    const provider = createDuckDuckGoProvider({
      runCommand: runCommandReturning("<div>No results found.</div>"),
      lookup: publicLookup,
    });
    await expect(provider.search(baseOptions)).resolves.toEqual([]);
  });
});

/**
 * Builds the curl stdout envelope that `parseCurlMeta` expects: the response
 * body followed by the trailing `__ATOMIC_WEB_SEARCH_META__status|ct|redir|size`
 * block that searchHttp appends via `curl -w`.
 */
function stubCurlStdout(html: string): string {
  return `${html}\n__ATOMIC_WEB_SEARCH_META__200|text/html||${html.length}`;
}
