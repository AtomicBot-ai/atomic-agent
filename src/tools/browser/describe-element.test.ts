import { afterEach, describe, expect, it, vi } from "vitest";
import { describeElementInPage, toRefDescription } from "./describe-element.js";
import { classifyBrowserAction } from "./classify-browser-action.js";

const CONTROL_SELECTOR =
  "button, [role=button], [role=link], a[href], input[type=submit], input[type=image], [role=menuitem], [role=tab]";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A hand-rolled stand-in for a DOM element: just the members the reader touches. */
function fakeElement(spec: {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  value?: string;
  form?: unknown;
  closest?: Record<string, unknown>;
}): unknown {
  const attrs = spec.attrs ?? {};
  return {
    tagName: spec.tag.toUpperCase(),
    textContent: spec.text ?? "",
    innerText: spec.text ?? "",
    value: spec.value,
    form: spec.form ?? null,
    labels: null,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string) => spec.closest?.[selector] ?? null,
  };
}

const form = (attrs: Record<string, string> = {}) => fakeElement({ tag: "form", attrs });

describe("describeElementInPage", () => {
  it("a default-type button inside a form is a submit control", () => {
    const facts = describeElementInPage(fakeElement({ tag: "button", text: " Save changes ", form: form({ action: "/s", method: "POST" }) }));
    expect(facts).toMatchObject({ tag: "button", isSubmit: true, inForm: true, formAction: "/s", formMethod: "POST" });
  });

  it("a type=button inside a form is not", () => {
    const facts = describeElementInPage(fakeElement({ tag: "button", attrs: { type: "button" }, form: form() }));
    expect(facts.isSubmit).toBe(false);
  });

  it("reads a password input without its value", () => {
    const facts = describeElementInPage(fakeElement({
      tag: "input",
      attrs: { type: "password", name: "pwd", autocomplete: "current-password", "aria-label": "Password" },
      value: "hunter2",
    }));
    expect(facts).toMatchObject({ type: "password", autocomplete: "current-password", editable: true, name: "Password" });
    expect(JSON.stringify(facts)).not.toContain("hunter2");
  });

  it("flags a field inside a search landmark", () => {
    const facts = describeElementInPage(fakeElement({ tag: "textarea", closest: { "[role=search], search": {} } }));
    expect(facts.inSearchForm).toBe(true);
  });

  it("names an input[type=submit] by its value", () => {
    const facts = describeElementInPage(fakeElement({ tag: "input", attrs: { type: "submit" }, value: "Send" }));
    expect(facts).toMatchObject({ name: "Send", isSubmit: true });
  });
});

describe("effective control", () => {
  it("an svg inside a form's default button describes the button: a submit, so it asks", () => {
    const button = fakeElement({ tag: "button", text: "Send", form: form({ method: "post" }) });
    const svg = fakeElement({ tag: "svg", closest: { [CONTROL_SELECTOR]: button } });
    const facts = describeElementInPage(svg);
    expect(facts).toMatchObject({ tag: "button", targetTag: "svg", isSubmit: true, inForm: true, name: "Send" });
    const verdict = classifyBrowserAction("click", toRefDescription(facts, "https://mail.example/"));
    expect(verdict.category).toBe("browser_commit");
  });

  it("names a control by aria-labelledby (Amazon's buy box)", () => {
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "lbl" ? { textContent: "Place your order" } : null),
    });
    const facts = describeElementInPage(fakeElement({ tag: "input", attrs: { type: "submit", "aria-labelledby": "lbl" } }));
    expect(facts.name).toBe("Place your order");
  });

  it("uses the element's own frame URL as the page URL", () => {
    vi.stubGlobal("location", { href: "https://js.stripe.com/v3/elements" });
    const facts = describeElementInPage(fakeElement({ tag: "input", attrs: { name: "cardnumber" } }));
    expect(toRefDescription(facts, "https://shop.example/cart").pageUrl).toBe("https://js.stripe.com/v3/elements");
  });
});

describe("toRefDescription", () => {
  it("collapses whitespace, caps the name and lowercases enums", () => {
    const raw = describeElementInPage(fakeElement({ tag: "a", attrs: { href: "/x", role: "LINK" }, text: `a\n\n  ${"b".repeat(400)}` }));
    const description = toRefDescription(raw, "https://example.com/");
    expect(description.name.startsWith("a b")).toBe(true);
    expect(description.name.length).toBe(120);
    expect(description.role).toBe("link");
    expect(description.href).toBe("/x");
    expect(description.pageUrl).toBe("https://example.com/");
  });
});
