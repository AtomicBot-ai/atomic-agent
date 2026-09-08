import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscordApiError } from "./discord-api.js";
import {
  formatDiscordAttachmentFailure,
  sendDiscordAttachments,
  type DiscordFileSender,
} from "./discord-outbound-attachments.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-discord-outbound-"));
  writeFileSync(join(dir, "shot.png"), "png");
  writeFileSync(join(dir, "report.pdf"), "pdf");
  mkdirSync(join(dir, "folder"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeApi(
  impl?: (channelId: string, file: { path: string; filename: string }) => Promise<unknown>,
): DiscordFileSender & { files: Array<{ channelId: string; path: string; filename: string }> } {
  const files: Array<{ channelId: string; path: string; filename: string }> = [];
  return {
    files,
    sendFile: vi.fn(async (channelId: string, file: { path: string; filename: string }) => {
      if (impl) await impl(channelId, file);
      files.push({ channelId, ...file });
      return "m1";
    }),
  };
}

describe("sendDiscordAttachments", () => {
  it("uploads each file in order under its basename", async () => {
    const api = makeApi();
    const result = await sendDiscordAttachments({
      api,
      channelId: "c1",
      paths: [join(dir, "shot.png"), join(dir, "report.pdf")],
    });
    expect(result).toEqual({ sent: 2, failed: [] });
    expect(api.files).toEqual([
      { channelId: "c1", path: join(dir, "shot.png"), filename: "shot.png" },
      { channelId: "c1", path: join(dir, "report.pdf"), filename: "report.pdf" },
    ]);
  });

  it("reports a missing file, a directory and an API failure without throwing", async () => {
    const token = ["A".repeat(24), "GaBcDe", "z".repeat(30)].join(".");
    const api = makeApi(async (_c, file) => {
      if (file.filename === "report.pdf") {
        throw new Error(`Could not reach Discord: fetch failed with ${token}`);
      }
    });
    const warn = vi.fn();
    const result = await sendDiscordAttachments({
      api,
      channelId: "c1",
      paths: [join(dir, "missing.txt"), join(dir, "folder"), join(dir, "report.pdf")],
      logger: { warn },
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toEqual([
      { path: join(dir, "missing.txt"), reason: "file not found" },
      { path: join(dir, "folder"), reason: "not a file" },
      {
        path: join(dir, "report.pdf"),
        reason: "Could not reach Discord: fetch failed with <token>",
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("explains a 413 as the server's upload limit", async () => {
    const api = makeApi(async () => {
      throw new DiscordApiError("Discord returned HTTP 413 for POST /channels/c1/messages.", 413);
    });
    const result = await sendDiscordAttachments({
      api,
      channelId: "c1",
      paths: [join(dir, "shot.png")],
    });
    expect(result.failed[0]!.reason).toBe(
      "over this server's upload limit (Discord returned HTTP 413)",
    );
  });

  it("formats the failure notice with the basename only", () => {
    expect(
      formatDiscordAttachmentFailure({ path: "/very/long/report.pdf", reason: "file not found" }),
    ).toBe("Could not send report.pdf: file not found");
  });
});
