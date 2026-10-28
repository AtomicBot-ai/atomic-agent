import { describe, expect, it } from "vitest";
import type { RefDescription } from "./browser-backend.js";
import {
  classifyBrowserAction,
  isPaymentPage,
  type BrowserActionKind,
} from "./classify-browser-action.js";

function el(over: Partial<RefDescription> = {}): RefDescription {
  return {
    tag: "div",
    targetTag: "div",
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
  // Text typed into an element we cannot read could be a password.
  ["type into uninspectable element", "type", null, "browser_secret"],
  // Vocabulary (round 1).
  ["Save", "click", el({ tag: "button", name: "Save" }), "browser_commit"],
  ["Allow (OAuth consent)", "click", el({ tag: "button", name: "Allow" }), "browser_commit"],
  ["Authorize app", "click", el({ tag: "button", name: "Authorize app" }), "browser_commit"],
  ["Accept invitation", "click", el({ tag: "button", name: "Accept invitation" }), "browser_commit"],
  ["Merge pull request", "click", el({ tag: "button", name: "Merge pull request" }), "browser_commit"],
  ["Unsubscribe", "click", el({ tag: "button", name: "Unsubscribe" }), "browser_commit"],
  ["Russian save", "click", el({ tag: "button", name: "Сохранить изменения" }), "browser_commit"],
  ["Russian allow", "click", el({ tag: "button", name: "Разрешить" }), "browser_commit"],
  ["German Absenden", "click", el({ tag: "button", name: "Absenden" }), "browser_commit"],
  ["German compound is not 'senden'", "click", el({ tag: "a", name: "Sendungsverfolgung" }), null],
  ["German compound is not 'speichern'", "click", el({ tag: "a", name: "Zwischenspeichern" }), null],
  ["Spanish enviar", "click", el({ tag: "button", name: "Enviar" }), "browser_commit"],
  ["French supprimer", "click", el({ tag: "button", name: "Supprimer" }), "browser_commit"],
  ["Chinese confirm delete", "click", el({ tag: "button", name: "确认删除" }), "browser_commit"],
  ["Chinese pay", "click", el({ tag: "button", name: "立即支付" }), "browser_secret"],
  ["Place your order", "click", el({ tag: "input", type: "submit", name: "Place your order", isSubmit: true, inForm: true }), "browser_secret"],
  ["Proceed to checkout", "click", el({ tag: "a", name: "Proceed to checkout", href: "/cart/checkout" }), "browser_secret"],
  // "subscribe" / "buy" alone: a commit, a secret only on a payment page.
  ["YouTube Subscribe", "click", el({ tag: "button", name: "Subscribe", pageUrl: "https://www.youtube.com/@channel" }), "browser_commit"],
  ["newsletter Subscribe", "click", el({ tag: "button", name: "Subscribe", isSubmit: true, inForm: true }), "browser_commit"],
  ["Buy alone off a payment page", "click", el({ tag: "button", name: "Buy" }), "browser_commit"],
  ["Subscribe on a checkout path", "click", el({ tag: "button", name: "Subscribe", pageUrl: "https://shop.example/checkout/plan" }), "browser_secret"],
  ["Subscribe on a payment host", "click", el({ tag: "button", name: "Subscribe", pageUrl: "https://checkout.stripe.com/c/pay/x" }), "browser_secret"],
  ["Continue on Amazon /gp/buy", "click", el({ tag: "input", type: "submit", name: "Continue", isSubmit: true, inForm: true, pageUrl: "https://www.amazon.com/gp/buy/spc/handlers/display.html" }), "browser_secret"],
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

  it("treats known payment hosts and checkout paths as payment pages", () => {
    expect(isPaymentPage("https://www.paypal.com/checkoutnow")).toBe(true);
    expect(isPaymentPage("https://www.amazon.com/gp/buy/spc")).toBe(true);
    expect(isPaymentPage("https://shop.example/checkout")).toBe(true);
    expect(isPaymentPage("https://www.youtube.com/watch?v=x")).toBe(false);
    expect(isPaymentPage("https://blog.example/paying-it-forward")).toBe(false);
  });
});
