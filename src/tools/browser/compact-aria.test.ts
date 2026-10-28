import { describe, expect, it } from "vitest";
import {
  diffView,
  interactiveView,
  parseAriaNode,
  regionView,
  splitSnapshotText,
} from "./compact-aria.js";

/** Compact page views for small models (ATO-956): pure functions over snapshot text. */

const PAGE = [
  "url: https://shop.example/cart",
  "title: Cart",
  "",
  '- banner [ref=e1]:',
  '  - link "Home" [ref=e2] [cursor=pointer]:',
  "    - /url: /",
  '- main [ref=e3]:',
  '  - heading "Your cart" [level=1] [ref=e4]',
  '  - paragraph [ref=e5]: Two items, total $40.',
  '  - generic [ref=e6] [cursor=pointer]: Remove all',
  '  - button "Checkout" [ref=e7] [cursor=pointer]',
  '  - checkbox "Gift wrap" [checked] [ref=e8]',
  '  - textbox "Coupon" [ref=e9]: SAVE10',
  "… [3 more lines truncated]",
].join("\n");

describe("parseAriaNode", () => {
  it("reads role, name, ref, flags and inline text", () => {
    expect(parseAriaNode('  - checkbox "Gift wrap" [checked] [ref=e8]')).toMatchObject({
      indent: 2,
      role: "checkbox",
      name: "Gift wrap",
      ref: "e8",
      flags: ["checked"],
    });
    expect(parseAriaNode("    - /url: /")).toBeNull();
  });
});

describe("splitSnapshotText", () => {
  it("separates header and compressor footer from the tree", () => {
    const split = splitSnapshotText(PAGE);
    expect(split.url).toBe("https://shop.example/cart");
    expect(split.title).toBe("Cart");
    expect(split.body.some((l) => l.startsWith("…"))).toBe(false);
  });
});

describe("interactiveView", () => {
  it("keeps every control with the ref Playwright gave it, drops page text", () => {
    const view = interactiveView(PAGE, 10_000);
    expect(view.text).toContain("view: interactive");
    expect(view.text).toContain('[e2] link "Home"');
    expect(view.text).toContain('[e7] button "Checkout"');
    expect(view.text).toContain('[e8] checkbox "Gift wrap" [checked]');
    expect(view.text).toContain('[e9] textbox "Coupon": SAVE10');
    expect(view.text).not.toContain("Two items");
    expect(view.text).toContain("## main [e3] › Your cart");
    expect(view.refs).toEqual(expect.arrayContaining(["e2", "e6", "e7", "e8", "e9"]));
  });

  it("does not hide a clickable element with a non-control role", () => {
    const view = interactiveView(PAGE, 10_000);
    expect(view.text).toContain("[e6] generic: Remove all");
  });

  it("does not list the pointer-marked parts inside a listed control twice", () => {
    const text = ['- button "Send" [ref=e1] [cursor=pointer]:', '  - img [ref=e2] [cursor=pointer]'].join("\n");
    const view = interactiveView(text, 10_000);
    expect(view.refs).toEqual(["e1"]);
  });

  it("shows longer names when clipped names would look the same", () => {
    const pad = "x".repeat(90);
    const text = [
      `- button "Delete ${pad} draft" [ref=e1]`,
      `- button "Delete ${pad} account" [ref=e2]`,
      `- button "${"y".repeat(100)}" [ref=e3]`,
    ].join("\n");
    const view = interactiveView(text, 10_000);
    expect(view.text).toContain("draft");
    expect(view.text).toContain("account");
    // A long name with no look-alike is still clipped.
    expect(view.text).not.toContain("y".repeat(100));
  });

  it("says how many lines the budget cut", () => {
    const many = Array.from({ length: 200 }, (_, i) => `- link "Item ${i}" [ref=e${i + 1}]`).join("\n");
    const view = interactiveView(many, 2_000);
    expect(view.truncated).toBe(true);
    expect(view.text).toMatch(/more lines over the size budget/);
  });
});

describe("regionView", () => {
  it("returns the subtree under a ref", () => {
    const view = regionView(PAGE, "e3", 10_000);
    expect(view?.text).toContain('button "Checkout" [ref=e7]');
    expect(view?.text).not.toContain('link "Home"');
    expect(view?.refs).toContain("e7");
  });

  it("is null for a ref that is not on the page", () => {
    expect(regionView(PAGE, "e99", 10_000)).toBeNull();
  });
});

describe("diffView", () => {
  it("shows added, changed and removed refs since the previous snapshot", () => {
    const next = PAGE.replace('  - checkbox "Gift wrap" [checked] [ref=e8]', '  - checkbox "Gift wrap" [ref=e8]')
      .replace('  - button "Checkout" [ref=e7] [cursor=pointer]', '  - button "Checkout" [disabled] [ref=e7]')
      .replace('  - textbox "Coupon" [ref=e9]: SAVE10', '  - alert [ref=e10]: Coupon expired');
    const view = diffView({ url: "https://shop.example/cart", text: PAGE }, next, 10_000);
    expect(view.fellBack).toBe(false);
    expect(view.text).toContain("view: diff");
    expect(view.text).toContain("+ [e10] alert: Coupon expired");
    expect(view.text).toMatch(/~ \[e7\] button "Checkout" \[disabled\]\s+\(was: button "Checkout"\)/);
    expect(view.text).toMatch(/~ \[e8\] checkbox "Gift wrap"\s+\(was: checkbox "Gift wrap" \[checked\]\)/);
    expect(view.text).toContain('- [e9] textbox "Coupon": SAVE10');
    // A removed ref is shown so the model stops using it, but is not live.
    expect(view.refs).not.toContain("e9");
    expect(view.refs).toEqual(expect.arrayContaining(["e10", "e7", "e8"]));
  });

  it("says when nothing changed", () => {
    const view = diffView({ url: "https://shop.example/cart", text: PAGE }, PAGE, 10_000);
    expect(view.text).toContain("(no changes since the previous snapshot)");
  });

  it("falls back to the interactive view on a new page or without history", () => {
    const fresh = diffView(undefined, PAGE, 10_000);
    expect(fresh.fellBack).toBe(true);
    expect(fresh.text).toContain("diff unavailable: no earlier snapshot");
    const moved = diffView({ url: "https://shop.example/other", text: PAGE }, PAGE, 10_000);
    expect(moved.fellBack).toBe(true);
    expect(moved.text).toContain("the URL changed");
  });
});
