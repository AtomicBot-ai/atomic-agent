/**
 * The annotate overlay (ATO-518): the user clicks elements in the agent's
 * browser window and each one gets a numbered pin; the agent reads the
 * pins back with selectors, styles and boxes.
 *
 * The scripts are JS source strings run in an isolated world of the page
 * (CDP `Page.createIsolatedWorld`, `annotate-playwright.ts`): they share
 * the DOM with the page but not its JavaScript, so the page's own scripts
 * cannot read the saved pins or forge them. The overlay lives in a closed
 * shadow root, only trusted (real input) events count, and clicks on the
 * page are swallowed while picking so a pin never presses a button.
 *
 * No text is typed on the page (ATO-1543). An earlier version had a
 * comment box in the overlay, but anything typed into the page's document
 * is visible to the page: key and input events are composed, so a page
 * listener on `window` in the capture phase sees every key before any
 * listener here can stop it, and an isolated world or a closed shadow
 * root does not change that. So the overlay only picks elements; what to
 * change about each numbered pin is said in the agent's own chat, which
 * the page cannot reach. Same split as Playwright codegen's picker and
 * Claude in Chrome: pick in the page, write in the host's UI. The overlay
 * never focuses anything, so keys keep going wherever the user had them.
 * Styles are
 * set through `element.style`, never a `<style>` tag or `innerHTML`, so a
 * strict Content-Security-Policy or Trusted Types page still shows it.
 * Strings, not functions: the SEA bundle keeps names and would wrap
 * nested helpers in `__name(...)`.
 *
 * Each script evaluates to a plain JSON value.
 */

/** Global (in the isolated world only) holding the overlay state. */
export const ANNOTATE_STATE_KEY = "__atomicAgentAnnotate";

/** Computed styles copied for each pin. */
export const ANNOTATE_STYLE_KEYS = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "border",
  "border-radius",
  "gap",
  "opacity",
] as const;

/**
 * The floating "Annotate" toggle (ATO-518, decision 72): it appears with
 * the overlay (after the first `start` on the page) and stays until
 * `stop`. A click turns picking on or off; its badge is the pin count.
 * Asking in chat (`start`) is the other way in.
 */
export const ANNOTATE_TOGGLE_LABEL = "Annotate";

/** Pins one page may hold; the overlay refuses more. */
export const MAX_PINS = 50;

/**
 * Start (or resume) picking. Evaluates to `{ started, pins }`: `started`
 * is false when the overlay was already on the page.
 */
export const ANNOTATE_START_SCRIPT = String.raw`(() => {
  const w = window;
  const doc = document;
  const KEY = "${ANNOTATE_STATE_KEY}";
  const MAX_PINS = ${MAX_PINS};
  const STYLE_KEYS = ${JSON.stringify(ANNOTATE_STYLE_KEYS)};
  const existing = w[KEY];
  if (existing && existing.host && existing.host.isConnected) {
    existing.picking = true;
    existing.render();
    return { started: false, pins: existing.pins.length };
  }
  if (existing && typeof existing.teardown === "function") existing.teardown();
  const state = { pins: [], nextId: 1, picking: true, host: null, render: null, teardown: null };
  w[KEY] = state;

  const make = (tag, css, text) => {
    const el = doc.createElement(tag);
    if (css) el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const host = make("atomic-agent-annotate", "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;");
  const root = host.attachShadow({ mode: "closed" });
  state.host = host;
  const FONT = "font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;";
  const ACCENT = "#7c3aed";
  const hl = make("div", "position: fixed; display: none; pointer-events: none; box-sizing: border-box; border: 2px solid " + ACCENT + "; background: rgba(124, 58, 237, 0.08); border-radius: 3px;");
  const layer = make("div", "position: fixed; inset: 0; pointer-events: none;");
  const bar = make("div", "position: fixed; top: 12px; right: 12px; pointer-events: auto; display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 8px; background: #1f1b2e; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.25); max-width: 360px; " + FONT);
  const barText = make("span", "flex: 1;");
  const toggle = make("button", "all: unset; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; padding: 3px 8px; border-radius: 5px; border: 1px solid " + ACCENT + "; color: #fff; " + FONT);
  const toggleLabel = make("span", "", "${ANNOTATE_TOGGLE_LABEL}");
  const countBadge = make("span", "min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #fff; color: " + ACCENT + "; text-align: center; font-size: 11px; line-height: 16px;", "0");
  toggle.append(toggleLabel, countBadge);
  toggle.setAttribute("aria-pressed", "true");
  bar.append(barText, toggle);
  root.append(hl, layer, bar);
  (doc.body || doc.documentElement).appendChild(host);

  const esc = (s) => (w.CSS && typeof w.CSS.escape === "function") ? w.CSS.escape(s) : String(s).replace(/[^A-Za-z0-9_-]/g, (c) => "\\" + c);
  const unique = (sel) => { try { return doc.querySelectorAll(sel).length === 1; } catch (e) { return false; } };
  const partOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute("id");
    if (id && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && unique("#" + esc(id))) return "#" + esc(id);
    let part = tag;
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
    }
    return part;
  };
  const LANDMARK_TAGS = ["main", "section", "article", "header", "footer", "nav", "aside", "form", "dialog"];
  const LANDMARK_ROLES = ["main", "region", "navigation", "banner", "contentinfo", "complementary", "form", "dialog", "search"];
  const factsOf = (el) => {
    const chain = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== doc.documentElement) {
      chain.unshift(cur);
      if (partOf(cur).charAt(0) === "#") break;
      cur = cur.parentElement;
    }
    const path = chain.map(partOf);
    let selector = path.join(" > ");
    for (let start = path.length - 1; start >= 0; start -= 1) {
      const candidate = path.slice(start).join(" > ");
      if (unique(candidate)) { selector = candidate; break; }
    }
    let regionDepth = -1;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const node = chain[i];
      const role = (node.getAttribute("role") || "").toLowerCase();
      if (LANDMARK_TAGS.indexOf(node.tagName.toLowerCase()) >= 0 || LANDMARK_ROLES.indexOf(role) >= 0) { regionDepth = i; break; }
    }
    if (regionDepth < 0) regionDepth = Math.min(1, chain.length - 1);
    const computed = w.getComputedStyle(el);
    const styles = {};
    for (const key of STYLE_KEYS) {
      const value = computed.getPropertyValue(key);
      if (value) styles[key] = value.slice(0, 200);
    }
    const r = el.getBoundingClientRect();
    const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
    return {
      selector: selector.slice(0, 500),
      tag: el.tagName.toLowerCase(),
      text: text,
      rect: { x: Math.round(r.left + w.scrollX), y: Math.round(r.top + w.scrollY), width: Math.round(r.width), height: Math.round(r.height) },
      styles: styles,
      path: path.slice(-30),
      regionDepth: Math.max(0, regionDepth - Math.max(0, path.length - 30)),
    };
  };
  state.factsOf = factsOf;

  const placeAt = (el, box, rect) => {
    el.style.left = Math.round(rect.left) + "px";
    el.style.top = Math.round(rect.top) + "px";
    if (box) { el.style.width = Math.round(rect.width) + "px"; el.style.height = Math.round(rect.height) + "px"; }
  };
  const render = () => {
    barText.textContent = state.picking ? "Click elements to pin them, then say in the agent's chat what to change for each number." : "";
    barText.style.display = state.picking ? "" : "none";
    countBadge.textContent = String(state.pins.length);
    toggle.setAttribute("aria-pressed", state.picking ? "true" : "false");
    toggle.title = state.picking ? "Leave annotate mode (pins stay)" : "Annotate: click elements to pin them";
    toggle.style.background = state.picking ? ACCENT : "transparent";
    layer.replaceChildren();
    for (const pin of state.pins) {
      if (!pin.el.isConnected) continue;
      const rect = pin.el.getBoundingClientRect();
      const outline = make("div", "position: fixed; pointer-events: none; box-sizing: border-box; border: 2px dashed " + ACCENT + "; border-radius: 3px;");
      placeAt(outline, true, rect);
      const badge = make("div", "position: fixed; pointer-events: auto; cursor: pointer; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px; background: " + ACCENT + "; color: #fff; text-align: center; transform: translate(-50%, -50%); " + FONT, String(pin.id));
      badge.title = "Pin " + pin.id + " (click to remove)";
      placeAt(badge, false, rect);
      badge.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        state.pins = state.pins.filter((other) => other !== pin);
        render();
      });
      layer.append(outline, badge);
    }
    if (!state.picking) hl.style.display = "none";
  };
  state.render = render;

  toggle.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    state.picking = !state.picking;
    render();
  });

  const outside = (event) => event.isTrusted && event.target !== host && !(event.target && host.contains(event.target));
  const pickable = (target) => target && target.nodeType === 1 && target !== doc.documentElement && target !== doc.body;
  const onMove = (event) => {
    if (!state.picking || !outside(event) || !pickable(event.target)) { hl.style.display = "none"; return; }
    placeAt(hl, true, event.target.getBoundingClientRect());
    hl.style.display = "block";
  };
  const swallow = (event) => {
    if (!state.picking || !outside(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onClick = (event) => {
    if (!state.picking || !outside(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!pickable(event.target)) return;
    if (state.pins.some((pin) => pin.el === event.target)) return;
    if (state.pins.length >= MAX_PINS) return;
    state.pins.push({ id: state.nextId, el: event.target, facts: factsOf(event.target) });
    state.nextId += 1;
    render();
  };
  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = w.requestAnimationFrame(() => { frame = 0; render(); });
  };
  const listeners = [
    ["mousemove", onMove],
    ["pointerdown", swallow],
    ["mousedown", swallow],
    ["pointerup", swallow],
    ["mouseup", swallow],
    ["dblclick", swallow],
    ["auxclick", swallow],
    ["contextmenu", swallow],
    ["click", onClick],
    ["scroll", onScroll],
    ["resize", onScroll],
  ];
  for (const [type, fn] of listeners) w.addEventListener(type, fn, { capture: true, passive: type === "scroll" });
  state.teardown = () => {
    for (const [type, fn] of listeners) w.removeEventListener(type, fn, { capture: true });
    host.remove();
  };
  render();
  return { started: true, pins: 0 };
})()`;

/**
 * The pins, with a fresh box for elements still on the page. Evaluates to
 * `{ active, picking, pins }`; `active` is false when no overlay was
 * started in this document.
 */
export const ANNOTATE_READ_SCRIPT = String.raw`(() => {
  const w = window;
  const state = w["${ANNOTATE_STATE_KEY}"];
  if (!state) return { active: false, picking: false, pins: [] };
  const pins = state.pins.map((pin) => {
    const attached = pin.el.isConnected;
    let facts = pin.facts;
    if (attached) { try { facts = state.factsOf(pin.el); } catch (e) { facts = pin.facts; } }
    return Object.assign({ id: pin.id, attached: attached }, facts);
  });
  return { active: true, picking: state.picking === true, pins: pins };
})()`;

/** Show or hide the overlay (it is hidden while element crops are taken). */
export function annotateVisibilityScript(visible: boolean): string {
  return String.raw`(() => {
  const state = window["${ANNOTATE_STATE_KEY}"];
  if (state && state.host) state.host.style.display = ${visible ? '""' : '"none"'};
  return true;
})()`;
}

/** Remove the overlay and forget the pins. Evaluates to the number of pins dropped. */
export const ANNOTATE_STOP_SCRIPT = String.raw`(() => {
  const w = window;
  const state = w["${ANNOTATE_STATE_KEY}"];
  if (!state) return 0;
  const count = state.pins.length;
  if (typeof state.teardown === "function") state.teardown();
  delete w["${ANNOTATE_STATE_KEY}"];
  return count;
})()`;
