import { describe, expect, it, vi } from "vitest";

import {
  LINEAR_ATTACHMENTS_PER_COMMENT,
  downloadLinearUpload,
  findLinearUploads,
  receiveLinearUploads,
} from "./linear-attachments.js";

describe("findLinearUploads", () => {
  it("finds markdown images, links and bare upload URLs once each, in order", () => {
    const body = [
      "look ![screen.png](https://uploads.linear.app/o/1/screen.png)",
      "and [log.txt](https://uploads.linear.app/o/2/log.txt)",
      "again https://uploads.linear.app/o/1/screen.png",
      "and https://uploads.linear.app/o/3/raw.csv",
    ].join("\n");
    expect(findLinearUploads(body)).toEqual([
      { name: "screen.png", url: "https://uploads.linear.app/o/1/screen.png" },
      { name: "log.txt", url: "https://uploads.linear.app/o/2/log.txt" },
      { name: "raw.csv", url: "https://uploads.linear.app/o/3/raw.csv" },
    ]);
  });

  it("ignores links to any other host, http, and look-alike hosts", () => {
    const body = [
      "[a](https://example.com/file.png)",
      "[b](http://uploads.linear.app/x.png)",
      "[c](https://uploads.linear.app.evil.dev/x.png)",
    ].join(" ");
    expect(findLinearUploads(body)).toEqual([]);
  });
});

function response(status: number, body: Uint8Array | null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("downloadLinearUpload", () => {
  it("sends the API key to uploads.linear.app only, and not along a redirect", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, null, { location: "https://storage.example.com/signed?x=1" }))
      .mockResolvedValueOnce(response(200, new Uint8Array([7, 8]), { "content-type": "image/png; charset=binary" }));
    const file = await downloadLinearUpload("https://uploads.linear.app/o/1/a.png", "lin_api_abc", fetchImpl as never);
    expect(file).toEqual({ bytes: new Uint8Array([7, 8]), mimeType: "image/png" });
    expect(fetchImpl.mock.calls[0]![1].headers).toEqual({ Authorization: "lin_api_abc" });
    expect(fetchImpl.mock.calls[1]![1].headers).toBeUndefined();
  });

  it("refuses a URL that is not a Linear upload without calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(downloadLinearUpload("https://evil.dev/a.png", "lin_api_abc", fetchImpl as never)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a file larger than the limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, new Uint8Array([1]), { "content-length": String(100 * 1024 * 1024) }));
    await expect(downloadLinearUpload("https://uploads.linear.app/o/big.zip", "k", fetchImpl as never)).rejects.toThrow(/limit/);
  });
});

describe("receiveLinearUploads", () => {
  it("saves what downloads, reports what does not, and names files past the cap", async () => {
    const uploads = Array.from({ length: LINEAR_ATTACHMENTS_PER_COMMENT + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      url: `https://uploads.linear.app/o/${i}`,
    }));
    const download = vi.fn(async (url: string) => {
      if (url.endsWith("/1")) throw new Error("Linear answered HTTP 404");
      return { bytes: new Uint8Array([1]) };
    });
    const save = vi.fn(async (input: { name?: string }) => ({ path: `/in/${input.name}`, name: input.name ?? "", bytes: 1, mimeType: null }));
    const outcomes = await receiveLinearUploads(uploads, {
      inbox: { dir: "/in", save },
      download,
      logger: { warn: vi.fn() },
    });
    expect(outcomes).toHaveLength(LINEAR_ATTACHMENTS_PER_COMMENT + 1);
    expect(outcomes[0]).toMatchObject({ status: "saved" });
    expect(outcomes[1]).toMatchObject({ status: "failed", name: "f1.txt", reason: "Linear answered HTTP 404" });
    expect(outcomes.at(-1)).toMatchObject({ status: "failed", name: `f${LINEAR_ATTACHMENTS_PER_COMMENT}.txt` });
    expect(download).toHaveBeenCalledTimes(LINEAR_ATTACHMENTS_PER_COMMENT);
  });
});
