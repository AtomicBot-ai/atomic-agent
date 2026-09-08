import { describe, expect, it } from "vitest";

import {
  DownloadGaveUpError,
  DownloadHttpError,
  StalledError,
  classifyDownloadError,
  createAbortError,
  isResumableDownloadError,
  isRetryableDownloadError,
} from "./download-errors.js";

function fetchFailed(code: string): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });
}

describe("classifyDownloadError", () => {
  it("sorts the link, the server, the setup and the caller apart", () => {
    expect(classifyDownloadError(fetchFailed("ENOTFOUND"))).toBe("transport");
    expect(classifyDownloadError(fetchFailed("ECONNRESET"))).toBe("transport");
    expect(classifyDownloadError(new StalledError(60_000))).toBe("transport");
    expect(classifyDownloadError(new Error("other side closed"))).toBe("transport");
    // A body cut mid-stream, as undici reports it.
    expect(
      classifyDownloadError(
        Object.assign(new TypeError("terminated"), {
          cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
        }),
      ),
    ).toBe("transport");
    expect(classifyDownloadError(fetchFailed("UND_ERR_CONNECT_TIMEOUT"))).toBe("transport");
    expect(classifyDownloadError(new DownloadHttpError(503, "Unavailable"))).toBe("server");
    expect(classifyDownloadError(new DownloadHttpError(429, "Too Many"))).toBe("server");
    expect(classifyDownloadError(new DownloadHttpError(404, "Not Found"))).toBe("fatal");
    expect(classifyDownloadError(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }))).toBe("fatal");
    expect(classifyDownloadError(fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe("fatal");
    expect(classifyDownloadError(Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" }))).toBe("fatal");
    expect(classifyDownloadError(new TypeError("x is not a function"))).toBe("fatal");
    expect(classifyDownloadError(createAbortError())).toBe("aborted");
    expect(
      classifyDownloadError(new DownloadGaveUpError("no-progress", "no progress", new Error("x"))),
    ).toBe("fatal");
  });

  it("answers retryable and resumable from the same classification", () => {
    expect(isRetryableDownloadError(fetchFailed("EAI_AGAIN"))).toBe(true);
    expect(isRetryableDownloadError(new DownloadHttpError(500, "x"))).toBe(true);
    expect(isRetryableDownloadError(new DownloadHttpError(401, "x"))).toBe(false);
    expect(isResumableDownloadError(fetchFailed("EAI_AGAIN"))).toBe(true);
    // A give-up is fatal for this call but resumable for the next one.
    expect(isResumableDownloadError(new DownloadGaveUpError("deadline", "d", new Error("x")))).toBe(true);
    expect(isResumableDownloadError(new DownloadHttpError(503, "x"))).toBe(false);
    expect(isResumableDownloadError(new DownloadHttpError(404, "x"))).toBe(false);
  });
});
