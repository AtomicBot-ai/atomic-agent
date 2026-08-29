import { describe, expect, it } from "vitest";
import {
  describeChallenge,
  detectChallenge,
} from "./web-fetch-challenge.js";

const CLOUDFLARE_200 = `<!DOCTYPE html><html><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="390"></head><body>
<div id="cf-wrapper"><h1>Enable JavaScript and cookies to continue</h1>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
</div></body></html>`;

const CLOUDFLARE_403 = `<!DOCTYPE html><html><head>
<title>Attention Required! | Cloudflare</title></head><body>
<h1>Sorry, you have been blocked</h1></body></html>`;

const REAL_ARTICLE = `<!DOCTYPE html><html><head><title>Rate limiting</title>
</head><body><article><h1>Rate limiting</h1><p>A rate limit is a cap on how
many requests a client may make. Servers behind a CDN often enforce one.</p>
</article></body></html>`;

describe("detectChallenge", () => {
  it("catches a challenge served as 200", () => {
    // The one that mattered most: extraction succeeds on these, so the
    // model received "Just a moment…" as the body of the article it
    // asked for, with nothing anywhere saying it had been fenced out.
    const verdict = detectChallenge({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: CLOUDFLARE_200,
    });
    expect(verdict.challenged).toBe(true);
    expect(verdict.marker).toBe("just a moment...");
  });

  it("catches a challenge served as 403", () => {
    const verdict = detectChallenge({
      status: 403,
      contentType: "text/html",
      body: CLOUDFLARE_403,
    });
    expect(verdict.challenged).toBe(true);
  });

  it("leaves a real page alone even when it discusses rate limits", () => {
    for (const status of [200, 403, 503]) {
      expect(
        detectChallenge({
          status,
          contentType: "text/html",
          body: REAL_ARTICLE,
        }).challenged,
      ).toBe(false);
    }
  });

  it("does not send the agent to a browser for an API refusal", () => {
    // A JSON 403 is a server saying no. Opening Chrome would be a
    // slower way to receive the same answer.
    expect(
      detectChallenge({
        status: 403,
        contentType: "application/json",
        body: '{"error":"forbidden","detail":"please verify you are a human"}',
      }).challenged,
    ).toBe(false);
  });

  it("ignores statuses a challenge is never served under", () => {
    expect(
      detectChallenge({
        status: 404,
        contentType: "text/html",
        body: CLOUDFLARE_200,
      }).challenged,
    ).toBe(false);
  });

  it("only scans the head of the body", () => {
    // A long document that happens to quote a marker deep inside is a
    // document, not a wall.
    const buried = `${"<p>ordinary prose.</p>".repeat(400)}just a moment...`;
    expect(
      detectChallenge({
        status: 200,
        contentType: "text/html",
        body: buried,
      }).challenged,
    ).toBe(false);
  });

  it("treats a missing content-type as possibly-html", () => {
    expect(
      detectChallenge({ status: 503, contentType: "", body: CLOUDFLARE_200 })
        .challenged,
    ).toBe(true);
  });
});

describe("describeChallenge", () => {
  it("names the tool that gets through, and says not to retry", () => {
    const message = describeChallenge(
      "https://example.com/a",
      403,
      "just a moment...",
    );
    expect(message).toContain("browser.navigate");
    expect(message).toContain("browser.read_aria");
    expect(message).toContain("do not re-fetch");
  });
});
