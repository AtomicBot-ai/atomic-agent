import { describe, expect, it, vi } from "vitest";

import type { ChatExport } from "../session/chat-export/index.js";
import { formatUploadPreview, gistCreateArgs, isYes, uploadSecretGist } from "./share-gist.js";

describe("gistCreateArgs", () => {
  it("creates a secret gist: never --public", () => {
    const args = gistCreateArgs("/state/chat.md", "Atomic Agent chat: x");
    expect(args).toEqual(["gist", "create", "/state/chat.md", "--desc", "Atomic Agent chat: x"]);
    expect(args).not.toContain("--public");
    expect(args).not.toContain("-p");
  });
});

describe("uploadSecretGist", () => {
  it("returns the link gh prints", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "https://gist.github.com/nadya/0123abcd\n", stderr: "- Creating gist chat.md\n" }));
    expect(await uploadSecretGist("/f.md", "d", run)).toEqual({ ok: true, url: "https://gist.github.com/nadya/0123abcd" });
    expect(run).toHaveBeenCalledWith("gh", ["gist", "create", "/f.md", "--desc", "d"]);
  });

  it("says when gh is missing", async () => {
    const run = async () => ({ code: 127, stdout: "", stderr: "", missing: true });
    const result = await uploadSecretGist("/f.md", "d", run);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("not installed");
  });

  it("passes on gh's last error line", async () => {
    const run = async () => ({ code: 1, stdout: "", stderr: "some noise\nHTTP 401: Bad credentials\n" });
    const result = await uploadSecretGist("/f.md", "d", run);
    expect(!result.ok && result.error).toContain("HTTP 401: Bad credentials");
  });

  it("fails when no link comes back", async () => {
    const run = async () => ({ code: 0, stdout: "done\n", stderr: "" });
    expect(await uploadSecretGist("/f.md", "d", run)).toEqual({ ok: false, error: "gh did not print a gist link." });
  });
});

describe("isYes", () => {
  it("accepts only a typed yes", () => {
    expect(["y", "Y", "yes", " YES "].every(isYes)).toBe(true);
    expect(["", "n", "no", "yeah", "ok", "y es"].some(isYes)).toBe(false);
  });
});

describe("formatUploadPreview", () => {
  const chat: ChatExport = {
    title: "Cart bug",
    messages: [
      { role: "user", text: "why\ndoes it crash" },
      { role: "assistant", text: "a".repeat(400) },
      { role: "user", text: "3" },
      { role: "assistant", text: "4" },
      { role: "user", text: "5" },
    ],
    exportedAt: new Date(0),
    counts: { secrets: 1, paths: 2, personal: 0, reasoning: 0 },
  };

  it("says what goes up, what was removed and who can read it", () => {
    const text = formatUploadPreview(chat, "/state/chat.md", 2048);
    expect(text).toContain("About to upload /state/chat.md (2.0 KB) as a secret GitHub gist");
    expect(text).toContain("messages: 5");
    expect(text).toContain("1 secret(s), 2 path(s)");
    expect(text).toContain("you   | why does it crash");
    expect(text).toContain("... 1 more");
    expect(text).toContain("anyone with the link can open it");
    expect(text).not.toContain("a".repeat(200));
  });
});
