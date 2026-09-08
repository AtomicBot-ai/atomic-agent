import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TelegramApi } from "./outbound-sender.js";
import {
  TELEGRAM_PHOTO_UPLOAD_LIMIT_BYTES,
  classifyOutboundFile,
  formatAttachmentFailure,
  sendAttachments,
  type OutboundFile,
} from "./outbound-attachments.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-tg-outbound-"));
  writeFileSync(join(dir, "shot.png"), "png");
  writeFileSync(join(dir, "report.pdf"), "pdf");
  mkdirSync(join(dir, "folder"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeApi(
  impl?: (chatId: number, file: OutboundFile) => Promise<unknown>,
): TelegramApi & { files: OutboundFile[]; sendFile: ReturnType<typeof vi.fn> } {
  const files: OutboundFile[] = [];
  const sendFile = vi.fn(async (chatId: number, file: OutboundFile) => {
    if (impl) await impl(chatId, file);
    files.push(file);
    return { message_id: files.length };
  });
  return { sendMessage: vi.fn(async () => ({ message_id: 0 })), sendFile, files };
}

describe("classifyOutboundFile", () => {
  it("sends images that fit the photo ceiling as photos, everything else as documents", () => {
    expect(classifyOutboundFile("/x/shot.PNG", 100)).toBe("photo");
    expect(classifyOutboundFile("/x/shot.jpeg", 100)).toBe("photo");
    expect(classifyOutboundFile("/x/anim.gif", 100)).toBe("document");
    expect(classifyOutboundFile("/x/report.pdf", 100)).toBe("document");
    expect(
      classifyOutboundFile("/x/huge.png", TELEGRAM_PHOTO_UPLOAD_LIMIT_BYTES + 1),
    ).toBe("document");
  });
});

describe("sendAttachments", () => {
  it("sends each file in order with the kind the extension implies", async () => {
    const api = makeApi();
    const result = await sendAttachments({
      api,
      chatId: 7,
      paths: [join(dir, "shot.png"), join(dir, "report.pdf")],
    });
    expect(result).toEqual({ sent: 2, failed: [] });
    expect(api.files).toEqual([
      { path: join(dir, "shot.png"), kind: "photo" },
      { path: join(dir, "report.pdf"), kind: "document" },
    ]);
    expect(api.sendFile.mock.calls[0]![0]).toBe(7);
  });

  it("retries a rejected photo as a document before giving up", async () => {
    const api = makeApi(async (_chat, file) => {
      if (file.kind === "photo") {
        throw Object.assign(new Error("Bad Request: PHOTO_INVALID_DIMENSIONS"), {
          error_code: 400,
        });
      }
    });
    const warn = vi.fn();
    const result = await sendAttachments({
      api,
      chatId: 7,
      paths: [join(dir, "shot.png")],
      logger: { warn },
    });
    expect(result).toEqual({ sent: 1, failed: [] });
    expect(api.files).toEqual([{ path: join(dir, "shot.png"), kind: "document" }]);
    expect(warn).toHaveBeenCalledWith(
      "telegram: photo send rejected, retrying as document",
      expect.objectContaining({ path: join(dir, "shot.png") }),
    );
  });

  it("reports a missing file, a directory and an API failure without throwing", async () => {
    const token = "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr";
    const api = makeApi(async (_chat, file) => {
      if (file.path.endsWith("report.pdf")) {
        throw new Error(`fetch failed: https://api.telegram.org/bot${token}/sendDocument`);
      }
    });
    const result = await sendAttachments({
      api,
      chatId: 7,
      paths: [join(dir, "missing.txt"), join(dir, "folder"), join(dir, "report.pdf")],
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toEqual([
      { path: join(dir, "missing.txt"), reason: "file not found" },
      { path: join(dir, "folder"), reason: "not a file" },
      {
        path: join(dir, "report.pdf"),
        reason: "fetch failed: https://api.telegram.org/bot<token>/sendDocument",
      },
    ]);
  });

  it("reports an adapter without sendFile as unsupported", async () => {
    const api: TelegramApi = { sendMessage: vi.fn(async () => ({ message_id: 0 })) };
    const result = await sendAttachments({ api, chatId: 7, paths: [join(dir, "shot.png")] });
    expect(result.failed[0]!.reason).toMatch(/not supported/);
  });

  it("formats the failure notice with the basename only", () => {
    expect(
      formatAttachmentFailure({ path: "/very/long/path/report.pdf", reason: "file not found" }),
    ).toBe("Could not send report.pdf: file not found");
  });
});
