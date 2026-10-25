import { describe, expect, it } from "vitest";
import { describeElementInPage, toRefDescription } from "./describe-element.js";

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
