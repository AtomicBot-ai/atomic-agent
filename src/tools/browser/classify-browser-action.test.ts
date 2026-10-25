import { describe, expect, it } from "vitest";
import type { RefDescription } from "./browser-backend.js";
import { classifyBrowserAction, type BrowserActionKind } from "./classify-browser-action.js";

function el(over: Partial<RefDescription> = {}): RefDescription {
  return {
    tag: "div",
    role: null,
    name: "",
    type: null,
    autocomplete: null,
    fieldHints: "",
    editable: false,
    inForm: false,
    formAction: null,
    formMethod: null,
    inSearchForm: false,
    isSubmit: false,
    href: null,
    pageUrl: "https://example.com/page",
    ...over,
  };
}

const input = (over: Partial<RefDescription> = {}): RefDescription =>
  el({ tag: "input", editable: true, ...over });

type Row = [string, BrowserActionKind, RefDescription | null, "browser_commit" | "browser_secret" | null];

const ROWS: Row[] = [
  // Secrets: typed text never matters, only the field.
  ["password input", "type", input({ type: "password", name: "Password" }), "browser_secret"],
  ["current-password autocomplete", "type", input({ type: "text", autocomplete: "username current-password" }), "browser_secret"],
  ["one-time code", "type", input({ autocomplete: "one-time-code" }), "browser_secret"],
  ["cc-number autocomplete", "type", input({ autocomplete: "cc-number" }), "browser_secret"],
  ["card number by name", "type", input({ fieldHints: "cardnumber card number" }), "browser_secret"],
  ["cvc by id", "type", input({ fieldHints: "cvc" }), "browser_secret"],
  ["expiry by placeholder", "type", input({ fieldHints: "mm / yy expiry" }), "browser_secret"],
  ["iban", "type", input({ fieldHints: "iban" }), "browser_secret"],
  ["password field with Enter", "type_enter", input({ type: "password", inForm: true }), "browser_secret"],
  ["Pay now button", "click", el({ tag: "button", name: "Pay now" }), "browser_secret"],
  ["Place order button", "click", el({ tag: "button", name: "Place order" }), "browser_secret"],
  ["Russian pay button", "click", el({ tag: "button", name: "Оплатить заказ" }), "browser_secret"],
  ["submit on a payment host", "click", el({ tag: "button", name: "Continue", isSubmit: true, inForm: true, pageUrl: "https://checkout.stripe.com/c/pay/x" }), "browser_secret"],
  // Commits.
  ["submit button", "click", el({ tag: "button", name: "Continue", isSubmit: true, inForm: true }), "browser_commit"],
  ["input type=submit", "click", el({ tag: "input", type: "submit", name: "Go", isSubmit: true, inForm: true }), "browser_commit"],
  ["Delete account div button", "click", el({ tag: "div", role: "button", name: "Delete account" }), "browser_commit"],
  ["Send", "click", el({ tag: "button", name: "Send" }), "browser_commit"],
  ["Publish", "click", el({ tag: "span", role: "button", name: "Publish" }), "browser_commit"],
  ["Sign up", "click", el({ tag: "button", name: "Sign up" }), "browser_commit"],
  ["Russian delete", "click", el({ tag: "button", name: "Удалить" }), "browser_commit"],
  ["Russian send", "click", el({ tag: "button", name: "Отправить сообщение" }), "browser_commit"],
  ["Enter in a form textbox", "type_enter", input({ name: "Comment", inForm: true }), "browser_commit"],
  ["Enter in a chat textbox outside a form", "type_enter", el({ tag: "div", role: "textbox", editable: true, name: "Message" }), "browser_commit"],
  ["click on uninspectable element", "click", null, "browser_commit"],
  ["type into uninspectable element", "type", null, "browser_commit"],
  // No prompt.
  ["plain link", "click", el({ tag: "a", name: "Learn more", href: "/docs" }), null],
  ["checkbox", "click", el({ tag: "input", type: "checkbox", name: "Remember me" }), null],
  ["tab", "click", el({ tag: "button", role: "tab", name: "Settings" }), null],
  ["menu item", "click", el({ tag: "div", role: "menuitem", name: "View profile" }), null],
  ["'Posts' is not 'post'", "click", el({ tag: "a", name: "Posts" }), null],
  ["'Payments history' is not 'pay'", "click", el({ tag: "a", name: "Payments history" }), null],
  ["search submit button", "click", el({ tag: "button", name: "Go", isSubmit: true, inForm: true, inSearchForm: true }), null],
  ["typing without Enter", "type", input({ name: "Comment", inForm: true }), null],
  ["Enter in role=searchbox", "type_enter", input({ role: "searchbox", inForm: true }), null],
  ["Enter in type=search", "type_enter", input({ type: "search", inForm: true }), null],
  ["Enter in a search landmark", "type_enter", el({ tag: "textarea", role: "combobox", editable: true, inForm: true, inSearchForm: true }), null],
  ["Enter in a q field", "type_enter", el({ tag: "textarea", editable: true, inForm: true, fieldHints: "q" }), null],
  ["Enter in a Russian search field", "type_enter", input({ name: "Поиск по сайту", inForm: true }), null],
];

describe("classifyBrowserAction", () => {
  it.each(ROWS)("%s", (_label, kind, element, expected) => {
    const verdict = classifyBrowserAction(kind, element);
    expect(verdict.category).toBe(expected);
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it("says why an uninspectable element asks", () => {
    expect(classifyBrowserAction("click", null).reason).toBe("could not inspect element");
  });
});
