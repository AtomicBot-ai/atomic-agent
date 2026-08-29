import { describe, expect, it } from "vitest";

import {
  CURL_META_MARKER,
  CURL_RETRY_AFTER_MARKER,
  parseCurlOutput,
} from "./http-request-fetch.js";

/** Build a `-w` meta line the way the shipped format string emits it. */
function meta(fields: {
  status?: string;
  contentType?: string;
  size?: string;
  time?: string;
  redirectUrl?: string;
  retryAfter?: string;
}): string {
  const {
    status = "200",
    contentType = "text/plain",
    size = "4",
    time = "0.01",
    redirectUrl = "",
    retryAfter = "",
  } = fields;
  return (
    `body\n${CURL_META_MARKER}${status}|${contentType}|${size}|${time}|` +
    `${redirectUrl}${CURL_RETRY_AFTER_MARKER}${retryAfter}`
  );
}

/**
 * Two of the fields on this line carry text the *origin* chose — the
 * redirect URL curl reports verbatim, and `Retry-After`, which is a raw
 * response header. Neither can be bounded by the `|` that separates the
 * fixed numeric fields, and for a while both shared it: `retry-after`
 * sat immediately before `redirect_url`, so a pipe inside the header
 * shifted the URL one field to the right.
 *
 * That is reachable by any origin, on the default follow-redirects
 * path, and it did not fail loudly — the caller got `x|https://real/`,
 * which fails the SSRF host check, so a plain 429-with-a-redirect was
 * reported back to the model as `blocked`.
 */
describe("the curl meta line survives origin-controlled text", () => {
  it("keeps the redirect URL whole when Retry-After contains a pipe", () => {
    const parsed = parseCurlOutput(
      meta({
        status: "429",
        redirectUrl: "https://good.example/next",
        retryAfter: "5|x",
      }),
    );
    expect(parsed.redirectUrl).toBe("https://good.example/next");
    expect(parsed.retryAfter).toBe("5|x");
  });

  it("keeps Retry-After whole when the redirect URL contains a pipe", () => {
    // RFC 3986 disallows a bare `|`, but origins emit it and curl
    // reports what it was given.
    const parsed = parseCurlOutput(
      meta({
        status: "429",
        redirectUrl: "https://good.example/a|b",
        retryAfter: "7",
      }),
    );
    expect(parsed.redirectUrl).toBe("https://good.example/a|b");
    expect(parsed.retryAfter).toBe("7");
  });

  it("still reads the fixed fields", () => {
    const parsed = parseCurlOutput(
      meta({ status: "503", contentType: "application/json", size: "4", time: "1.5" }),
    );
    expect(parsed.status).toBe(503);
    expect(parsed.contentType).toBe("application/json");
    expect(parsed.sizeDownload).toBe(4);
    expect(parsed.timeTotal).toBe(1.5);
    expect(parsed.body).toBe("body");
  });

  it("reports no Retry-After on a curl too old for %header{}", () => {
    // Before 7.83 curl echoes the format string instead of a value.
    const parsed = parseCurlOutput(
      meta({ retryAfter: "%header{retry-after}" }),
    );
    expect(parsed.retryAfter).toBe("");
  });

  it("tolerates a line with no sentinel at all", () => {
    const parsed = parseCurlOutput(
      `body\n${CURL_META_MARKER}200|text/plain|4|0.01|https://x.example/`,
    );
    expect(parsed.status).toBe(200);
    expect(parsed.redirectUrl).toBe("https://x.example/");
    expect(parsed.retryAfter).toBe("");
  });
});
