import { describe, expect, it } from "vitest";

import { pickTelegramFile } from "./telegram-file-update.js";

describe("pickTelegramFile", () => {
  it("takes the largest rendition of a photo", () => {
    const file = pickTelegramFile({
      photo: [
        { file_id: "small", file_size: 1_000 },
        { file_id: "large", file_size: 90_000 },
        { file_id: "medium", file_size: 20_000 },
      ],
    });
    expect(file).toEqual({ kind: "photo", file_id: "large", file_size: 90_000 });
  });

  it("prefers animation over the document alias Telegram sends with it", () => {
    const file = pickTelegramFile({
      animation: { file_id: "anim", mime_type: "video/mp4", file_name: "cat.mp4" },
      document: { file_id: "anim", mime_type: "video/mp4", file_name: "cat.mp4" },
    });
    expect(file?.kind).toBe("animation");
  });

  it("carries the document name and MIME through", () => {
    const file = pickTelegramFile({
      document: {
        file_id: "doc",
        file_unique_id: "u",
        file_size: 12,
        file_name: "report.pdf",
        mime_type: "application/pdf",
      },
    });
    expect(file).toEqual({
      kind: "document",
      file_id: "doc",
      file_unique_id: "u",
      file_size: 12,
      file_name: "report.pdf",
      mime_type: "application/pdf",
    });
  });

  it("names stickers by their format", () => {
    expect(pickTelegramFile({ sticker: { file_id: "s" } })).toMatchObject({
      kind: "sticker",
      file_name: "sticker.webp",
      mime_type: "image/webp",
    });
    expect(
      pickTelegramFile({ sticker: { file_id: "s", is_animated: true } }),
    ).toMatchObject({ file_name: "sticker.tgs", mime_type: "application/x-tgsticker" });
    expect(
      pickTelegramFile({ sticker: { file_id: "s", is_video: true } }),
    ).toMatchObject({ file_name: "sticker.webm", mime_type: "video/webm" });
  });

  it("returns null for a message with no file", () => {
    expect(pickTelegramFile({})).toBeNull();
    expect(pickTelegramFile({ photo: [] })).toBeNull();
  });
});
