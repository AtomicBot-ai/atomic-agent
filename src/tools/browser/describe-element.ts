import type { RefDescription } from "./browser-backend.js";

/**
 * Raw facts read inside the page by `describeElementInPage`. Kept apart
 * from `RefDescription` because nothing here is trimmed or capped yet.
 * `frameUrl` is `location.href` where the element lives (its iframe, if
 * any); `toRefDescription` prefers it over the top page URL.
 */
export type RawElementFacts = Omit<RefDescription, "pageUrl"> & { frameUrl: string };

/**
 * The structural slice of a DOM element `describeElementInPage` reads.
 * tsc targets Node libs here (no `dom`), so the page side is typed by
 * hand, the same way `PlaywrightBackend.scroll` does it.
 */
interface PageElement {
  tagName: string;
  textContent: string | null;
  innerText?: string;
  value?: string;
  isContentEditable?: boolean;
  form?: PageElement | null;
  labels?: ArrayLike<{ textContent: string | null }> | null;
  getAttribute(name: string): string | null;
  closest(selector: string): PageElement | null;
}

interface PageGlobals {
  document?: { getElementById(id: string): { textContent: string | null } | null };
  location?: { href: string };
}

/**
 * Runs in the page through `locator.evaluate`, so Playwright serialises
 * its source: it must not call anything defined outside its own body
 * (no helpers, no nested named functions a bundler could wrap). Reads
 * attributes and text only, never an input's typed value.
 *
 * A click on an icon, a `<span>` or an `<img>` inside a button lands on
 * the button, so the facts describe the nearest enclosing control (the
 * "effective control"); `targetTag` keeps the ref'd element's own tag.
 */
export function describeElementInPage(node: unknown): RawElementFacts {
  const target = node as PageElement;
  const el =
    target.closest(
      "button, [role=button], [role=link], a[href], input[type=submit], input[type=image], [role=menuitem], [role=tab]",
    ) ?? target;
  const page = globalThis as unknown as PageGlobals;
  const tag = String(el.tagName || "").toLowerCase();
  const typeAttr = (el.getAttribute("type") || "").toLowerCase();
  const ariaLabel = el.getAttribute("aria-label") || "";
  let labelledText = "";
  const labelledBy = el.getAttribute("aria-labelledby") || "";
  const doc = page.document;
  if (labelledBy && doc) {
    for (const id of labelledBy.split(/\s+/)) {
      const labelEl = id ? doc.getElementById(id) : null;
      if (labelEl) labelledText += ` ${labelEl.textContent || ""}`;
    }
  }
  labelledText = labelledText.trim();
  const labelText =
    el.labels && el.labels.length > 0 ? String(el.labels[0]!.textContent || "") : "";
  const buttonValue =
    tag === "input" && (typeAttr === "submit" || typeAttr === "button" || typeAttr === "reset")
      ? String(el.value || "")
      : "";
  const text = tag === "input" || tag === "textarea" ? "" : String(el.innerText ?? el.textContent ?? "");
  const name =
    ariaLabel || labelledText || labelText || buttonValue || text || el.getAttribute("title") ||
    el.getAttribute("alt") || el.getAttribute("placeholder") || "";
  const form = el.form ?? el.closest("form");
  const searchLandmark = el.closest("[role=search], search");
  const isSubmit =
    (tag === "button" && form !== null && (typeAttr === "" || typeAttr === "submit")) ||
    (tag === "input" && (typeAttr === "submit" || typeAttr === "image"));
  const fieldHints = [
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("placeholder"),
    ariaLabel,
    labelledText,
    labelText,
  ].filter(Boolean).join(" ");
  return {
    tag,
    targetTag: String(target.tagName || "").toLowerCase(),
    role: el.getAttribute("role"),
    name,
    type: typeAttr === "" ? null : typeAttr,
    autocomplete: el.getAttribute("autocomplete"),
    fieldHints,
    editable: tag === "input" || tag === "textarea" || el.isContentEditable === true,
    inForm: form !== null,
    formAction: form ? form.getAttribute("action") : null,
    formMethod: form ? form.getAttribute("method") : null,
    inSearchForm:
      searchLandmark !== null || (form !== null && form.getAttribute("role") === "search"),
    isSubmit,
    href: tag === "a" || el.getAttribute("role") === "link" ? el.getAttribute("href") : null,
    frameUrl: page.location ? String(page.location.href || "") : "",
  };
}

const NAME_CAP = 120;
const HINTS_CAP = 200;
const URL_CAP = 300;

function clean(value: string | null | undefined, cap: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, cap);
}

function cleanOrNull(value: string | null | undefined, cap: number): string | null {
  const cleaned = clean(value, cap);
  return cleaned.length > 0 ? cleaned : null;
}

/** Normalise page-side facts: collapse whitespace, cap lengths, lowercase enums. */
export function toRefDescription(raw: RawElementFacts, pageUrl: string): RefDescription {
  const frameUrl = clean(raw.frameUrl, URL_CAP * 4);
  return {
    tag: clean(raw.tag, 32).toLowerCase(),
    targetTag: clean(raw.targetTag, 32).toLowerCase(),
    role: cleanOrNull(raw.role, 32)?.toLowerCase() ?? null,
    name: clean(raw.name, NAME_CAP),
    type: cleanOrNull(raw.type, 32)?.toLowerCase() ?? null,
    autocomplete: cleanOrNull(raw.autocomplete, 64)?.toLowerCase() ?? null,
    fieldHints: clean(raw.fieldHints, HINTS_CAP).toLowerCase(),
    editable: raw.editable === true,
    inForm: raw.inForm === true,
    formAction: cleanOrNull(raw.formAction, URL_CAP),
    formMethod: cleanOrNull(raw.formMethod, 16)?.toLowerCase() ?? null,
    inSearchForm: raw.inSearchForm === true,
    isSubmit: raw.isSubmit === true,
    href: cleanOrNull(raw.href, URL_CAP),
    // The element's own frame decides the host (an iframe checkout on a
    // shop page is the payment provider's page, not the shop's).
    pageUrl: frameUrl.length > 0 && frameUrl !== "about:blank" ? frameUrl : clean(pageUrl, URL_CAP * 4),
  };
}
