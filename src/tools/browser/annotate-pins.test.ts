import { describe, expect, it } from "vitest";
import { groupPins, renderPin, sanitizePins, type AnnotationPin } from "./annotate-pins.js";

/** Pins from the annotate overlay (ATO-518): checks, grouping by DOM subtree, rendering. */

function raw(id: number, path: string[], regionDepth: number, over: Record<string, unknown> = {}) {
  return {
    id,
    comment: `change ${id}`,
    selector: path.slice(-2).join(" > "),
    tag: "button",
    text: "Buy now",
    rect: { x: 10, y: 20, width: 120, height: 40 },
    styles: { color: "rgb(0, 0, 0)", "background-color": "rgb(255, 255, 255)", "font-size": "14px" },
    path,
    regionDepth,
    attached: true,
    ...over,
  };
}

describe("sanitizePins", () => {
  it("keeps well-formed pins in id order and drops empty, duplicate or broken ones", () => {
    const pins = sanitizePins([
      raw(2, ["body", "main"], 1),
      raw(1, ["body", "main"], 1),
      raw(1, ["body"], 0),
      raw(3, ["body"], 0, { comment: "   " }),
      raw(0, ["body"], 0),
      "junk",
    ]);
    expect(pins.map((pin) => pin.id)).toEqual([1, 2]);
  });

  it("caps text, drops odd style keys and clamps the region depth", () => {
    const [pin] = sanitizePins([
      raw(1, ["body", "div"], 9, {
        comment: `a\nb ${"x".repeat(3_000)}`,
        styles: { color: "red", "BAD KEY": "x", "font-size": 12 },
        rect: { x: 1.6, y: "no", width: -5, height: 10 },
      }),
    ]);
    expect(pin?.comment.startsWith("a b ")).toBe(true);
    expect(pin?.comment.length).toBe(2_000);
    expect(pin?.styles).toEqual({ color: "red" });
    expect(pin?.rect).toEqual({ x: 2, y: 0, width: 0, height: 10 });
    expect(pin?.regionDepth).toBe(1);
  });

  it("keeps at most 50 pins", () => {
    const many = Array.from({ length: 60 }, (_, i) => raw(i + 1, ["body"], 0));
    expect(sanitizePins(many)).toHaveLength(50);
  });
});

describe("groupPins", () => {
  it("groups pins by the landmark they share and merges nested regions", () => {
    const pins = sanitizePins([
      // Two pins in the pricing section.
      raw(1, ["#pricing", "div:nth-of-type(1)", "button"], 0),
      raw(3, ["#pricing", "div:nth-of-type(2)", "h3"], 0),
      // One in the header.
      raw(2, ["body", "header", "nav", "a:nth-of-type(2)"], 1),
      // A form inside the header region: nested, so the same group.
      raw(4, ["body", "header", "form", "input"], 2),
      // The footer.
      raw(5, ["body", "footer", "p"], 1),
    ]);
    expect(groupPins(pins)).toEqual([
      { region: "#pricing", pinIds: [1, 3] },
      { region: "body > header", pinIds: [2, 4] },
      { region: "body > footer", pinIds: [5] },
    ]);
  });

  it("puts every pin in exactly one group", () => {
    const pins = sanitizePins(Array.from({ length: 10 }, (_, i) => raw(i + 1, ["body", `div:nth-of-type(${i % 3})`, "span"], 1)));
    const groups = groupPins(pins);
    expect(groups.flatMap((group) => group.pinIds).sort((a, b) => a - b)).toEqual(pins.map((pin) => pin.id));
    expect(groups).toHaveLength(3);
  });
});

describe("renderPin", () => {
  it("shows the comment, element, selector, box, styles and crop", () => {
    const pin = sanitizePins([raw(7, ["#pricing", "button"], 0)])[0] as AnnotationPin;
    const text = renderPin(pin, "/tmp/shot.jpg").join("\n");
    expect(text).toContain("[7] comment: change 7");
    expect(text).toContain('<button> "Buy now"');
    expect(text).toContain("selector: #pricing > button");
    expect(text).toContain("box: 120x40 at (10, 20)");
    expect(text).toContain("color: rgb(0, 0, 0)");
    expect(text).toContain("crop: /tmp/shot.jpg");
    const gone = renderPin({ ...pin, attached: false }).join("\n");
    expect(gone).toContain("no longer on the page");
  });
});
