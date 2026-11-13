import { describe, expect, it } from "vitest";
import {
  ANNOTATE_READ_SCRIPT,
  ANNOTATE_START_SCRIPT,
  ANNOTATE_STATE_KEY,
  ANNOTATE_STOP_SCRIPT,
  ANNOTATE_TOGGLE_LABEL,
  annotateVisibilityScript,
} from "./annotate-in-page.js";

/** Just enough DOM for the start script to build its overlay. */
interface FakeEl {
  tagName: string;
  style: Record<string, string>;
  textContent: string;
  title: string;
  children: FakeEl[];
  attrs: Record<string, string>;
  listeners: Record<string, Array<(event: unknown) => void>>;
  isConnected: boolean;
  [key: string]: unknown;
}

function fakeEl(tag: string): FakeEl {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    style: {},
    textContent: "",
    title: "",
    children: [],
    attrs: {},
    listeners: {},
    isConnected: true,
  };
  Object.assign(el, {
    append: (...kids: FakeEl[]) => { el.children.push(...kids); },
    appendChild: (kid: FakeEl) => { el.children.push(kid); return kid; },
    replaceChildren: (...kids: FakeEl[]) => { el.children = kids; },
    remove: () => { el.isConnected = false; },
    contains: () => false,
    focus: () => undefined,
    setAttribute: (name: string, value: string) => { el.attrs[name] = String(value); },
    getAttribute: (name: string) => el.attrs[name] ?? null,
    addEventListener: (type: string, fn: (event: unknown) => void) => { (el.listeners[type] ??= []).push(fn); },
    attachShadow: () => el,
  });
  return el;
}

function startOverlay(): { win: Record<string, unknown>; toggle: FakeEl; badge: FakeEl } {
  const made: FakeEl[] = [];
  const body = fakeEl("body");
  const doc = { body, documentElement: body, createElement: (tag: string) => { const el = fakeEl(tag); made.push(el); return el; } };
  const win: Record<string, unknown> = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestAnimationFrame: () => 1,
    innerWidth: 1200,
    innerHeight: 800,
  };
  new Function("window", "document", `return ${ANNOTATE_START_SCRIPT};`)(win, doc);
  const toggle = made.find((el) => el.tagName === "BUTTON" && "aria-pressed" in el.attrs);
  if (!toggle) throw new Error("no toggle");
  const badge = toggle.children[1];
  if (!badge) throw new Error("no badge");
  return { win, toggle, badge };
}

/**
 * The annotate overlay scripts (ATO-518). They run in a real page through
 * CDP, so here only their shape is pinned: they parse, and they keep the
 * safety properties the README promises.
 */

describe("annotate page scripts", () => {
  it("parse as JavaScript", () => {
    for (const source of [
      ANNOTATE_START_SCRIPT,
      ANNOTATE_READ_SCRIPT,
      ANNOTATE_STOP_SCRIPT,
      annotateVisibilityScript(true),
      annotateVisibilityScript(false),
    ]) {
      expect(() => new Function(source)).not.toThrow();
    }
  });

  it("use a closed shadow root, trusted events only, and no CSP-sensitive sinks", () => {
    expect(ANNOTATE_START_SCRIPT).toContain('attachShadow({ mode: "closed" })');
    expect(ANNOTATE_START_SCRIPT).toContain("event.isTrusted");
    expect(ANNOTATE_START_SCRIPT).not.toContain("innerHTML");
    expect(ANNOTATE_START_SCRIPT).not.toContain("<style");
    // Never reads what is typed in the page's own fields.
    expect(ANNOTATE_START_SCRIPT.replaceAll("area.value", "")).not.toContain(".value");
  });

  it("read and stop do nothing on a page without the overlay", () => {
    const fakeWindow: Record<string, unknown> = {};
    const run = (source: string) => new Function("window", `return ${source};`)(fakeWindow);
    expect(run(ANNOTATE_READ_SCRIPT)).toEqual({ active: false, picking: false, pins: [] });
    expect(run(ANNOTATE_STOP_SCRIPT)).toBe(0);
    expect(run(annotateVisibilityScript(false))).toBe(true);
    expect(fakeWindow[ANNOTATE_STATE_KEY]).toBeUndefined();
  });

  it("read refreshes facts for attached pins and keeps the saved ones for removed elements", () => {
    const el = { isConnected: true };
    const gone = { isConnected: false };
    const fakeWindow: Record<string, unknown> = {
      [ANNOTATE_STATE_KEY]: {
        picking: true,
        factsOf: () => ({ selector: "#fresh" }),
        pins: [
          { id: 1, comment: "a", el, facts: { selector: "#old" } },
          { id: 2, comment: "b", el: gone, facts: { selector: "#saved" } },
        ],
      },
    };
    const read = new Function("window", `return ${ANNOTATE_READ_SCRIPT};`)(fakeWindow);
    expect(read).toEqual({
      active: true,
      picking: true,
      pins: [
        { id: 1, comment: "a", attached: true, selector: "#fresh" },
        { id: 2, comment: "b", attached: false, selector: "#saved" },
      ],
    });
  });

  it("the Annotate toggle turns picking on and off, and its badge counts the pins (decision 72)", () => {
    const { win, toggle, badge } = startOverlay();
    const state = win[ANNOTATE_STATE_KEY] as { picking: boolean; pins: unknown[]; render: () => void };
    const click = () => { for (const fn of toggle.listeners.click ?? []) fn({ isTrusted: true }); };
    expect(toggle.children[0]?.textContent).toBe(ANNOTATE_TOGGLE_LABEL);
    // `start` turns it on.
    expect(state.picking).toBe(true);
    expect(toggle.attrs["aria-pressed"]).toBe("true");
    click();
    expect(state.picking).toBe(false);
    expect(toggle.attrs["aria-pressed"]).toBe("false");
    click();
    expect(state.picking).toBe(true);
    expect(toggle.attrs["aria-pressed"]).toBe("true");
    // A page script's synthetic click does not flip it.
    for (const fn of toggle.listeners.click ?? []) fn({ isTrusted: false });
    expect(state.picking).toBe(true);
    expect(badge.textContent).toBe("0");
    state.pins.push({ id: 1, comment: "a", el: { isConnected: false } }, { id: 2, comment: "b", el: { isConnected: false } });
    state.render();
    expect(badge.textContent).toBe("2");
    // A pin is read back the same with picking off.
    click();
    const read = new Function("window", `return ${ANNOTATE_READ_SCRIPT};`)(win) as { picking: boolean; pins: unknown[] };
    expect(read.picking).toBe(false);
    expect(read.pins).toHaveLength(2);
  });

  it("the comment box warns that the page can see what is typed", () => {
    expect(ANNOTATE_START_SCRIPT).toContain("This page can see what you type here");
  });
});
