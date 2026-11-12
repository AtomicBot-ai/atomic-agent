import { describe, expect, it } from "vitest";
import {
  createInlineImageStore,
  imageBoxFor,
  inlineImageRows,
  MAX_INLINE_IMAGE_BYTES,
  toolCardImagePaths,
  toolCardInlineImages,
} from "./inline-image-store.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function fakeFs(files: Record<string, Uint8Array>, sizes: Record<string, number> = {}) {
  const reads: string[] = [];
  return {
    reads,
    options: {
      firstId: 100,
      readFile: (path: string) => {
        reads.push(path);
        const file = files[path];
        if (!file) throw new Error("ENOENT");
        return file;
      },
      fileSize: (path: string) => {
        if (path in sizes) return sizes[path]!;
        const file = files[path];
        if (!file) throw new Error("ENOENT");
        return file.length;
      },
    },
  };
}

function card(paths: unknown, status = "ok", tool = "image.generate") {
  return { tool, status, details: { paths } };
}

describe("toolCardImagePaths", () => {
  it("takes the saved paths of a finished image.generate card", () => {
    expect(toolCardImagePaths(card(["/a.png", "/b.png"]))).toEqual(["/a.png", "/b.png"]);
  });

  it("ignores failed cards, other tools and junk", () => {
    expect(toolCardImagePaths(card(["/a.png"], "error"))).toEqual([]);
    expect(toolCardImagePaths(card(["/a.png"], "ok", "os.fs.read"))).toEqual([]);
    expect(toolCardImagePaths(card("/a.png"))).toEqual([]);
    expect(toolCardImagePaths(card([1, "", "/a.png"]))).toEqual(["/a.png"]);
    expect(toolCardImagePaths({ tool: "image.generate" })).toEqual([]);
  });

  it("caps at four pictures", () => {
    expect(toolCardImagePaths(card(["1", "2", "3", "4", "5"]))).toHaveLength(4);
  });
});

describe("createInlineImageStore", () => {
  it("sizes a PNG, gives it an id and reads it once", () => {
    const fs = fakeFs({ "/a.png": png(1344, 768) });
    const store = createInlineImageStore(fs.options);
    const first = store.load("/a.png", { cols: 40, rows: 12 });
    expect(first).toEqual({ path: "/a.png", id: 100, cols: 40, rows: 11 });
    expect(store.load("/a.png", { cols: 40, rows: 12 })).toBe(first);
    expect(fs.reads).toEqual(["/a.png"]);
  });

  it("refuses non-PNG, missing, empty and oversized files", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const fs = fakeFs(
      { "/j.jpg": jpeg, "/big.png": png(10, 10), "/empty.png": new Uint8Array(0) },
      { "/big.png": MAX_INLINE_IMAGE_BYTES + 1 },
    );
    const store = createInlineImageStore(fs.options);
    const box = { cols: 40, rows: 12 };
    expect(store.load("/j.jpg", box)).toBeNull();
    expect(store.load("/missing.png", box)).toBeNull();
    expect(store.load("/empty.png", box)).toBeNull();
    expect(store.load("/big.png", box)).toBeNull();
    // An oversized file is never read at all.
    expect(fs.reads).not.toContain("/big.png");
  });

  it("hands out the transmit once and remembers it for the exit cleanup", () => {
    const fs = fakeFs({ "/a.png": png(100, 100) });
    const store = createInlineImageStore(fs.options);
    expect(store.takeTransmit("/a.png")).toBeNull(); // not loaded yet
    store.load("/a.png", { cols: 40, rows: 12 });
    const sequence = store.takeTransmit("/a.png");
    expect(sequence).toContain("\u001b_Ga=T,U=1,f=100,t=d,i=100,");
    expect(store.takeTransmit("/a.png")).toBeNull();
    expect(store.deleteAllSequence()).toBe("\u001b_Ga=d,d=I,i=100,q=2\u001b\\");
  });
});

describe("toolCardInlineImages", () => {
  const fs = () => fakeFs({ "/a.png": png(1024, 1024), "/b.png": png(1024, 1024) });

  it("is empty unless the protocol is kitty", () => {
    const store = createInlineImageStore(fs().options);
    expect(toolCardInlineImages(card(["/a.png"]), null, store)).toEqual([]);
    expect(toolCardInlineImages(card(["/a.png"]), "iterm2", store)).toEqual([]);
  });

  it("splits the 40-column box between pictures on one row", () => {
    expect(imageBoxFor(1)).toEqual({ cols: 40, rows: 12 });
    expect(imageBoxFor(2)).toEqual({ cols: 19, rows: 12 });
    expect(imageBoxFor(4)).toEqual({ cols: 9, rows: 12 });
    const store = createInlineImageStore(fs().options);
    const images = toolCardInlineImages(card(["/a.png", "/b.png", "/gone.png"]), "kitty", store);
    expect(images.map((i) => i.path)).toEqual(["/a.png", "/b.png"]);
    expect(images.every((i) => i.cols <= 19)).toBe(true);
    expect(new Set(images.map((i) => i.id)).size).toBe(2);
    expect(inlineImageRows(images)).toBe(Math.max(...images.map((i) => i.rows)));
    expect(inlineImageRows([])).toBe(0);
  });
});
