import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";
import { handleKey, type KeyContext } from "../multi-line-editor-keys.js";
import { routeVimKey, runVimKey } from "./vim-keys.js";
import { createVimState, type VimState } from "./vim-types.js";

function k(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  } as Key;
}

const NORMAL = createVimState("normal");
const INSERT = createVimState("insert");

describe("routeVimKey", () => {
  it("INSERT claims only Esc, which goes to NORMAL one character left", () => {
    expect(routeVimKey(INSERT, { value: "ab", cursor: 2 }, "x", k()).handled).toBe(false);
    expect(
      routeVimKey(INSERT, { value: "ab", cursor: 2 }, "", k({ return: true })).handled,
    ).toBe(false);
    const esc = routeVimKey(INSERT, { value: "ab", cursor: 2 }, "", k({ escape: true }));
    expect(esc.handled).toBe(true);
    expect(esc.state.mode).toBe("normal");
    expect(esc.buffer.cursor).toBe(1);
    const atStart = routeVimKey(INSERT, { value: "a\nb", cursor: 2 }, "", k({ escape: true }));
    expect(atStart.buffer.cursor).toBe(2);
  });

  it("NORMAL lets a bare Esc through, so Esc keeps its old meaning", () => {
    expect(
      routeVimKey(NORMAL, { value: "ab", cursor: 0 }, "", k({ escape: true })).handled,
    ).toBe(false);
  });

  it("NORMAL Esc with a half-typed command only drops the command", () => {
    const pending: VimState = { ...NORMAL, operator: "d", count: "3" };
    const esc = routeVimKey(pending, { value: "ab", cursor: 0 }, "", k({ escape: true }));
    expect(esc.handled).toBe(true);
    expect(esc.state.operator).toBeNull();
    expect(esc.state.count).toBe("");
    expect(esc.buffer).toEqual({ value: "ab", cursor: 0 });
  });

  it("NORMAL leaves chords, arrows, Tab, Home/End and pastes to the editor", () => {
    const buffer = { value: "ab", cursor: 0 };
    for (const key of [
      k({ ctrl: true }),
      k({ meta: true }),
      k({ super: true }),
      k({ tab: true }),
      k({ upArrow: true }),
      k({ leftArrow: true }),
      k({ home: true }),
      k({ pageDown: true }),
    ]) {
      expect(routeVimKey(NORMAL, buffer, "c", key).handled).toBe(false);
    }
    expect(routeVimKey(NORMAL, buffer, "pasted text", k()).handled).toBe(false);
    expect(routeVimKey(NORMAL, buffer, "", k()).handled).toBe(false);
  });

  it("NORMAL swallows unknown printable keys instead of typing them", () => {
    const step = routeVimKey(NORMAL, { value: "ab", cursor: 0 }, "q", k());
    expect(step.handled).toBe(true);
    expect(step.buffer).toEqual({ value: "ab", cursor: 0 });
  });

  it("NORMAL Backspace / Delete move left instead of deleting", () => {
    const back = routeVimKey(NORMAL, { value: "abc", cursor: 2 }, "", k({ backspace: true }));
    expect(back.handled).toBe(true);
    expect(back.buffer).toEqual({ value: "abc", cursor: 1 });
    const del = routeVimKey(NORMAL, { value: "abc", cursor: 2 }, "", k({ delete: true }));
    expect(del.buffer).toEqual({ value: "abc", cursor: 1 });
  });

  it("NORMAL Enter falls through to submit and starts the next message in INSERT", () => {
    const sent = routeVimKey(NORMAL, { value: "hi", cursor: 1 }, "", k({ return: true }));
    expect(sent.handled).toBe(false);
    expect(sent.state.mode).toBe("insert");
    const empty = routeVimKey(NORMAL, { value: "  ", cursor: 0 }, "", k({ return: true }));
    expect(empty.state.mode).toBe("normal");
    const newline = routeVimKey(
      NORMAL,
      { value: "hi", cursor: 1 },
      "",
      k({ return: true, shift: true }),
    );
    expect(newline.state.mode).toBe("normal");
  });
});

/**
 * The editor's grammar with the vim layer plugged in, the way
 * `MultiLineEditor` wires it: one buffer, keys in order.
 */
function session(initial = "", mode: VimState["mode"] = "insert") {
  let value = initial;
  let cursor = initial.length;
  let anchor: number | null = null;
  let vim = createVimState(mode);
  const onSubmit = vi.fn();
  const onEscape = vi.fn();
  const onInterrupt = vi.fn();
  const press = (input: string, key: Key = k()): void => {
    const ctx: KeyContext = {
      input,
      key,
      value,
      cursor,
      setBuffer: (next, at) => {
        value = next;
        cursor = at;
      },
      selection: null,
      anchor,
      setAnchor: (next) => {
        anchor = next;
      },
      copySelection: () => {},
      onSubmit,
      onEscape,
      onInterrupt,
      vim: (c) => {
        const r = runVimKey(vim, c);
        vim = r.state;
        return r.handled;
      },
    };
    handleKey(ctx);
  };
  const type = (text: string): void => {
    for (const ch of text) press(ch);
  };
  const esc = (): void => press("", k({ escape: true }));
  return {
    press,
    type,
    esc,
    onSubmit,
    onEscape,
    onInterrupt,
    get value() {
      return value;
    },
    get cursor() {
      return cursor;
    },
    get mode() {
      return vim.mode;
    },
    setAnchor(next: number) {
      anchor = next;
    },
    get anchor() {
      return anchor;
    },
  };
}

describe("vim layer inside the editor grammar", () => {
  it("types in INSERT, edits in NORMAL, and u takes it back", () => {
    const s = session();
    s.type("hello world");
    s.esc();
    expect(s.mode).toBe("normal");
    expect(s.cursor).toBe(10);
    s.type("b");
    expect(s.cursor).toBe(6);
    s.type("cw");
    expect(s.mode).toBe("insert");
    s.type("there");
    s.esc();
    expect(s.value).toBe("hello there");
    s.type("u");
    expect(s.value).toBe("hello world");
  });

  it("u after i…Esc removes the whole insert session", () => {
    const s = session("ab", "normal");
    s.type("0i");
    s.type("xyz");
    s.esc();
    expect(s.value).toBe("xyzab");
    s.type("u");
    expect(s.value).toBe("ab");
  });

  it("keys in NORMAL are commands, never text", () => {
    const s = session("abc", "normal");
    s.type("0x");
    expect(s.value).toBe("bc");
    s.type("q");
    expect(s.value).toBe("bc");
  });

  it("Esc in NORMAL still reaches the editor's Esc handler", () => {
    const s = session("draft");
    s.esc();
    expect(s.onEscape).not.toHaveBeenCalled();
    s.esc();
    expect(s.onEscape).toHaveBeenCalledTimes(1);
  });

  it("Enter in NORMAL submits the buffer", () => {
    const s = session("send me", "normal");
    s.press("\r", k({ return: true }));
    expect(s.onSubmit).toHaveBeenCalledWith("send me");
    expect(s.mode).toBe("insert");
  });

  it("Ctrl+C in NORMAL is still the interrupt", () => {
    const s = session("x", "normal");
    s.press("c", k({ ctrl: true }));
    expect(s.onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("a claimed key collapses a mouse selection", () => {
    const s = session("abc", "normal");
    s.setAnchor(0);
    s.type("l");
    expect(s.anchor).toBeNull();
  });

  it("without the vim hook the grammar is unchanged", () => {
    let value = "";
    handleKey({
      input: "x",
      key: k(),
      value,
      cursor: 0,
      setBuffer: (next) => {
        value = next;
      },
      selection: null,
      anchor: null,
      setAnchor: () => {},
      copySelection: () => {},
      onSubmit: () => {},
    });
    expect(value).toBe("x");
  });
});
