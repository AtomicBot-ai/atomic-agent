import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createInlineImageStore } from "./inline-image-store.js";
import { ToolCardImages } from "./tool-card-images.js";

const PLACEHOLDER = "\u{10EEEE}";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function storeWith(files: Record<string, Uint8Array>) {
  return createInlineImageStore({
    firstId: 5,
    readFile: (p) => {
      const f = files[p];
      if (!f) throw new Error("ENOENT");
      return f;
    },
    fileSize: (p) => {
      const f = files[p];
      if (!f) throw new Error("ENOENT");
      return f.length;
    },
  });
}

const card = {
  tool: "image.generate",
  status: "ok",
  details: { paths: ["/w/image.png"] },
};

function placeholdersPerLine(frame: string): number[] {
  return frame
    .split("\n")
    .map((line) => [...line].filter((ch) => ch === PLACEHOLDER).length)
    .filter((n) => n > 0);
}

describe("ToolCardImages", () => {
  it("draws the picture as a grid of placeholder cells and sends it once", () => {
    const store = storeWith({ "/w/image.png": png(1344, 768) });
    const { frames, rerender, unmount } = render(
      <ToolCardImages card={card} protocol="kitty" store={store} />,
    );
    const grid = frames.find((f) => f.includes(PLACEHOLDER)) ?? "";
    // 1344x768 fits 40 x 11; every row stays whole (Ink measures one
    // column per cell, so nothing is cut or wrapped).
    expect(placeholdersPerLine(grid)).toEqual(new Array<number>(11).fill(40));
    const transmits = () => frames.filter((f) => f.includes("\u001b_Ga=T,U=1,f=100")).length;
    expect(transmits()).toBe(1);
    rerender(<ToolCardImages card={card} protocol="kitty" store={store} />);
    expect(transmits()).toBe(1);
    unmount();
  });

  it("renders nothing when the protocol is off or not kitty", () => {
    const store = storeWith({ "/w/image.png": png(100, 100) });
    for (const protocol of [null, "iterm2"] as const) {
      const { lastFrame, unmount } = render(
        <ToolCardImages card={card} protocol={protocol} store={store} />,
      );
      expect(lastFrame() ?? "").not.toContain(PLACEHOLDER);
      unmount();
    }
  });

  it("renders nothing for a card without a readable PNG", () => {
    const store = storeWith({});
    const { lastFrame, unmount } = render(
      <ToolCardImages card={card} protocol="kitty" store={store} />,
    );
    expect(lastFrame() ?? "").not.toContain(PLACEHOLDER);
    unmount();
  });
});
