import type { RefDescription } from "./browser-backend.js";
import { hostMatchesAny, webHostOf } from "./browser-domain-policy.js";
import { isOneTimeCodeHint } from "./redact-secret-fields.js";

/**
 * Decides whether a `browser.click` / `browser.type` must ask first, and
 * under which approval category. Pure: the element facts come from
 * `BrowserBackend.describeRef`, and the typed text is never an input
 * (only the tool's preview sees its length).
 *
 *  - `browser_secret` (level 5, never granted): typing into a password,
 *    one-time-code or payment card field; a click that pays; anything
 *    commit-like on a payment page (a known payment host, or a
 *    checkout-like path such as `/checkout` or Amazon's `/gp/buy`).
 *  - `browser_commit` (level 4, grantable): a submit control; a click
 *    whose name sends, posts, publishes, deletes, saves, confirms,
 *    authorises or registers (English, Russian, basic DE/ES/FR/PT/IT/ZH);
 *    "buy" / "subscribe" / "order" off a payment page; Enter in a form or
 *    a non-search text field; a click on an element that could not be
 *    inspected (fail closed). Typing into one asks as a secret.
 *  - `null`: everything else (links, tabs, checkboxes, menus, typing
 *    without Enter, Enter in a search box).
 */
export type BrowserActionKind = "click" | "type" | "type_enter";

export type BrowserActionCategory = "browser_commit" | "browser_secret";

export interface BrowserActionVerdict {
  category: BrowserActionCategory | null;
  reason: string;
}

/** Hosts whose pages exist to take money. Matched with subdomains. */
export const PAYMENT_HOSTS: readonly string[] = [
  "checkout.stripe.com",
  "buy.stripe.com",
  "paypal.com",
  "pay.google.com",
  "pay.amazon.com",
  "checkout.shopify.com",
  "klarna.com",
  "pay.yandex.ru",
  "yoomoney.ru",
];

const SECRET_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code"];

/** Card / bank field names, matched against name / id / placeholder / label. */
const CARD_FIELD = /card.?num|cardnumber|\bcc-?(num|number|csc|exp)|\bcvc\b|\bcvv2?\b|\bcsc\b|security.?code|expir|exp.?date|\biban\b|номер.?карт/;
const PASSWORD_FIELD = /pass(word|wd)|\bpwd\b|\botp\b|пароль/;

/**
 * Pay outright, wherever they appear. Whole words / phrases.
 */
const PAYMENT_WORDS = [
  "pay", "pay now", "buy now", "checkout", "check out", "proceed to checkout",
  "place order", "place your order", "purchase", "complete purchase",
  "complete order", "confirm payment",
];
/**
 * Might take money: secret on a payment page, otherwise a commit. A
 * YouTube "Subscribe" or a newsletter sign-up is not a payment, and a
 * level-5 never-granted prompt on every one of them is friction with no
 * safety gain.
 */
const MAYBE_PAYMENT_WORDS = ["buy", "subscribe", "donate", "order", "book"];
const COMMIT_WORDS = [
  "send", "submit", "post", "publish", "delete", "remove", "confirm", "sign up",
  "signup", "register", "transfer", "create account", "deactivate", "tweet", "reply",
  "save", "apply", "continue", "allow", "authorize", "authorise", "approve", "grant",
  "accept", "agree", "merge", "archive", "comment", "share", "unsubscribe",
  "cancel subscription", "leave", "block", "close account",
  // German, Spanish, French, Portuguese, Italian: whole words only, so a
  // German compound ("Absenden") is listed rather than matched inside.
  "senden", "absenden", "speichern", "löschen", "bestätigen",
  "enviar", "guardar", "eliminar", "borrar", "confirmar",
  "envoyer", "enregistrer", "supprimer", "valider", "confirmer",
  "salvar", "excluir",
  "inviare", "invia", "salva", "elimina", "conferma",
];
/** Russian stems, matched at a word start (inflection makes whole words useless). */
const PAYMENT_STEMS = ["оплат", "оформить заказ"];
const MAYBE_PAYMENT_STEMS = ["купить", "заказать"];
const COMMIT_STEMS = [
  "отправ", "удал", "опублик", "подтверд", "зарегистр", "перевест",
  "сохранить", "разрешить", "принять", "согласен", "согласиться",
];
/** Chinese has no word boundaries: plain substrings. */
const PAYMENT_CJK = ["支付", "付款"];
const MAYBE_PAYMENT_CJK = ["购买"];
const COMMIT_CJK = ["提交", "发送", "保存", "删除", "确认"];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A Unicode-aware whole-word / word-start / substring matcher (`\b` is ASCII-only). */
function buildMatcher(
  words: readonly string[],
  stems: readonly string[],
  substrings: readonly string[] = [],
): RegExp {
  const whole = words.map((w) => `${escapeRegExp(w).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`);
  const starts = stems.map((st) => escapeRegExp(st).replace(/ /g, "\\s+"));
  const bounded = `(?<![\\p{L}\\p{N}])(?:${[...whole, ...starts].join("|")})`;
  const parts = [bounded, ...substrings.map(escapeRegExp)];
  return new RegExp(parts.join("|"), "iu");
}

const PAYMENT_NAME = buildMatcher(PAYMENT_WORDS, PAYMENT_STEMS, PAYMENT_CJK);
const MAYBE_PAYMENT_NAME = buildMatcher(MAYBE_PAYMENT_WORDS, MAYBE_PAYMENT_STEMS, MAYBE_PAYMENT_CJK);
const COMMIT_NAME = buildMatcher(COMMIT_WORDS, COMMIT_STEMS, COMMIT_CJK);
const SEARCH_NAME = buildMatcher(["search", "find"], ["поиск", "найти", "искать"]);

/** Paths that are checkout steps on any shop (`/checkout`, Amazon's `/gp/buy`). */
const CHECKOUT_PATH = /\/(checkout|payment|pay|billing)(\/|$|\?)|\/gp\/buy(\/|$)/i;

/** A known payment host, or a checkout-like path on any web host. */
export function isPaymentPage(pageUrl: string): boolean {
  const host = webHostOf(pageUrl);
  if (host === null) return false;
  if (hostMatchesAny(host, PAYMENT_HOSTS)) return true;
  try {
    return CHECKOUT_PATH.test(new URL(pageUrl).pathname);
  } catch {
    return false;
  }
}

function secretFieldReason(element: RefDescription): string | null {
  if (element.type === "password") return "password field";
  const tokens = (element.autocomplete ?? "").split(/\s+/);
  if (tokens.some((t) => SECRET_AUTOCOMPLETE.includes(t))) return "password or one-time-code field";
  if (tokens.some((t) => t.startsWith("cc-"))) return "payment card field";
  if (CARD_FIELD.test(element.fieldHints)) return "payment card field";
  if (PASSWORD_FIELD.test(element.fieldHints)) return "password field";
  if (isOneTimeCodeHint(element.fieldHints)) return "one-time code field";
  return null;
}

function isSearchField(element: RefDescription): boolean {
  return (
    element.role === "searchbox" ||
    element.type === "search" ||
    element.inSearchForm ||
    SEARCH_NAME.test(element.name) ||
    SEARCH_NAME.test(element.fieldHints) ||
    /(^|\s)q(\s|$)/.test(element.fieldHints)
  );
}

function classifyClick(element: RefDescription): BrowserActionVerdict {
  const label = element.name || element.tag;
  if (PAYMENT_NAME.test(element.name)) {
    return { category: "browser_secret", reason: `click on payment control "${label}"` };
  }
  let commit: string | null = null;
  if (COMMIT_NAME.test(element.name) || MAYBE_PAYMENT_NAME.test(element.name)) {
    commit = `click on "${label}"`;
  }
  else if (element.isSubmit && !element.inSearchForm) commit = `click submits a form ("${label}")`;
  if (commit === null) return { category: null, reason: "no commit-like action" };
  if (isPaymentPage(element.pageUrl)) {
    return { category: "browser_secret", reason: `${commit} on a payment page` };
  }
  return { category: "browser_commit", reason: commit };
}

function classifyType(element: RefDescription, pressEnter: boolean): BrowserActionVerdict {
  const secret = secretFieldReason(element);
  if (secret !== null) return { category: "browser_secret", reason: `typing into a ${secret}` };
  if (!pressEnter) return { category: null, reason: "typing without Enter" };
  if (isSearchField(element)) return { category: null, reason: "Enter in a search field" };
  if (!element.inForm && !element.editable) {
    return { category: null, reason: "Enter outside a form or text field" };
  }
  const reason = element.inForm ? "Enter submits a form" : "Enter in a text field may send it";
  if (isPaymentPage(element.pageUrl)) {
    return { category: "browser_secret", reason: `${reason} on a payment page` };
  }
  return { category: "browser_commit", reason };
}

export function classifyBrowserAction(
  kind: BrowserActionKind,
  element: RefDescription | null,
): BrowserActionVerdict {
  if (element === null) {
    // Fail closed: an element we cannot read could be anything. Text
    // typed into it could be a password, so that asks as a secret.
    return kind === "click"
      ? { category: "browser_commit", reason: "could not inspect element" }
      : { category: "browser_secret", reason: "could not inspect element" };
  }
  if (kind === "click") return classifyClick(element);
  return classifyType(element, kind === "type_enter");
}
