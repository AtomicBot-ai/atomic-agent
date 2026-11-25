import { describe, expect, it } from "vitest";

import {
  assembleStreamOrder,
  layoutPageText,
  type PdfTextItem,
} from "./pdf-layout.js";

/** A horizontal run at (x, y) in PDF user space, font size h. */
function run(
  str: string,
  x: number,
  y: number,
  opts: { w?: number; h?: number } = {},
): PdfTextItem {
  const h = opts.h ?? 10;
  return {
    str,
    transform: [h, 0, 0, h, x, y],
    width: opts.w ?? str.length * h * 0.5,
    height: h,
  };
}

const LEFT_X = 50;
const RIGHT_X = 320;
const COL_W = 230;

function twoColumnPage(order: "rows" | "columns"): PdfTextItem[] {
  const left = [1, 2, 3, 4, 5, 6].map((n) =>
    run(`left line ${n}`, LEFT_X, 700 - (n - 1) * 12, { w: COL_W }),
  );
  const right = [1, 2, 3, 4, 5, 6].map((n) =>
    run(`right line ${n}`, RIGHT_X, 700 - (n - 1) * 12, { w: COL_W }),
  );
  if (order === "columns") return [...left, ...right];
  return left.flatMap((l, i) => [l, right[i]!]);
}

describe("layoutPageText", () => {
  it("reads two prose columns left then right, even when the stream interleaves them", () => {
    const text = layoutPageText(twoColumnPage("rows"));
    expect(text.split("\n")).toEqual([
      "left line 1",
      "left line 2",
      "left line 3",
      "left line 4",
      "left line 5",
      "left line 6",
      "right line 1",
      "right line 2",
      "right line 3",
      "right line 4",
      "right line 5",
      "right line 6",
    ]);
  });

  it("puts a full-width title before the columns under it", () => {
    const items = [
      ...twoColumnPage("rows"),
      run("A Title Across Both Columns", LEFT_X, 740, { w: 500, h: 16 }),
    ];
    const lines = layoutPageText(items).split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("A Title Across Both Columns");
    expect(lines[1]).toBe("left line 1");
    expect(lines[7]).toBe("right line 1");
  });

  it("splits ragged columns (lists) when the stream wrote them column by column", () => {
    const widths = [230, 60, 50, 70, 40, 60];
    const left = widths.map((w, i) => run(`L${i + 1}`, LEFT_X, 700 - i * 12, { w }));
    const right = widths.map((w, i) => run(`R${i + 1}`, RIGHT_X, 700 - i * 12, { w }));
    const text = layoutPageText([...left, ...right]);
    expect(text).toBe("L1\nL2\nL3\nL4\nL5\nL6\nR1\nR2\nR3\nR4\nR5\nR6");
  });

  const table = (): PdfTextItem[] => {
    const rows: [string, number, string, number][] = [
      ["Name", 24, "Alice", 30],
      ["Email address", 78, "alice@example.com", 102],
      ["Age", 18, "30", 12],
      ["City", 24, "Paris", 30],
      ["Country of residence", 120, "France", 36],
      ["Zip", 18, "75001", 30],
    ];
    return rows.flatMap(([k, kw, v, vw], i) => [
      run(k, LEFT_X, 700 - i * 14, { w: kw }),
      run(v, RIGHT_X, 700 - i * 14, { w: vw }),
    ]);
  };

  it("keeps a two-column table row by row with cell separators", () => {
    expect(layoutPageText(table())).toBe(
      [
        "Name | Alice",
        "Email address | alice@example.com",
        "Age | 30",
        "City | Paris",
        "Country of residence | France",
        "Zip | 75001",
      ].join("\n"),
    );
  });

  it("uses plain spaces for wide gaps when table rendering is off", () => {
    expect(layoutPageText(table(), { tables: false }).split("\n")[0]).toBe("Name Alice");
  });

  it("orders runs on a line by x and only adds spaces at real gaps", () => {
    const items = [
      run("world", 78, 700, { w: 25 }),
      run("lo", 65, 700, { w: 10 }),
      run("Hel", 50, 700, { w: 15 }),
    ];
    expect(layoutPageText(items)).toBe("Hello world");
  });

  it("keeps superscripts on their line and drops fake-bold duplicates", () => {
    const items = [
      run("E = mc", 50, 700, { w: 30 }),
      run("2", 80, 704, { w: 3, h: 6 }),
      run("Bold", 50, 680, { w: 20 }),
      run("Bold", 50.3, 680, { w: 20 }),
    ];
    expect(layoutPageText(items)).toBe("E = mc2\nBold");
  });

  it("separates paragraphs on a larger vertical gap", () => {
    const items = [700, 688, 676, 640, 628].map((y, i) => run(`line ${i + 1}`, 50, y, { w: 40 }));
    expect(layoutPageText(items)).toBe("line 1\nline 2\nline 3\n\nline 4\nline 5");
  });

  it("appends a rotated side stamp after the page body", () => {
    const stamp: PdfTextItem = {
      str: "arXiv:2601.00001v1",
      transform: [0, 10, -10, 0, 20, 300],
      width: 90,
      height: 10,
    };
    const text = layoutPageText([stamp, ...twoColumnPage("columns")]);
    expect(text.startsWith("left line 1")).toBe(true);
    expect(text.endsWith("arXiv:2601.00001v1")).toBe(true);
  });

  it("falls back to stream order when runs have no coordinates", () => {
    const items: PdfTextItem[] = [
      { str: "first", hasEOL: true },
      { str: "second" },
    ];
    expect(layoutPageText(items)).toBe(assembleStreamOrder(items));
    expect(layoutPageText(items)).toBe("first\nsecond");
  });

  it("returns an empty string for a page without text", () => {
    expect(layoutPageText([])).toBe("");
    expect(layoutPageText([run("   ", 50, 700)])).toBe("");
  });
});
