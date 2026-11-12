import { describe, expect, it } from "vitest";
import {
  MAX_SELECT_VALUES,
  MAX_UPLOAD_FILES,
  MAX_WAIT_MS,
  MAX_WAIT_TIMEOUT_MS,
  keyCommits,
  parsePageAction,
} from "./page-action-args.js";

describe("parsePageAction", () => {
  it("rejects a missing or unknown action, naming the choices", () => {
    expect(() => parsePageAction({})).toThrow(/action.*select\|upload\|back\|forward\|key\|hover\|dialog\|wait/);
    expect(() => parsePageAction({ action: "drag" })).toThrow(/browser\.act/);
  });

  it("select: needs a ref and values; a lone string or `value` is one value", () => {
    expect(parsePageAction({ action: "select", ref: "e4", values: ["us", "ca"] }))
      .toEqual({ action: "select", ref: "e4", values: ["us", "ca"] });
    expect(parsePageAction({ action: "select", ref: "e4", value: "Canada" }))
      .toEqual({ action: "select", ref: "e4", values: ["Canada"] });
    expect(() => parsePageAction({ action: "select", values: ["us"] })).toThrow(/ref/);
    expect(() => parsePageAction({ action: "select", ref: "e4" })).toThrow(/values/);
    expect(() => parsePageAction({ action: "select", ref: "e4", values: [] })).toThrow(/values/);
    expect(() => parsePageAction({ action: "select", ref: "e4", values: [""] })).toThrow(/non-empty/);
    expect(() => parsePageAction({
      action: "select", ref: "e4", values: Array.from({ length: MAX_SELECT_VALUES + 1 }, (_, i) => `v${i}`),
    })).toThrow(/at most/);
  });

  it("select / hover / upload refuse a ref that is not a snapshot ref", () => {
    expect(() => parsePageAction({ action: "hover", ref: "#menu" })).toThrow(/alphanumeric/);
    expect(() => parsePageAction({ action: "select", ref: "a b", values: ["x"] })).toThrow(/alphanumeric/);
  });

  it("upload: a path or paths, capped", () => {
    expect(parsePageAction({ action: "upload", ref: "e2", path: "cv.pdf" }))
      .toEqual({ action: "upload", ref: "e2", paths: ["cv.pdf"] });
    expect(() => parsePageAction({ action: "upload", ref: "e2" })).toThrow(/paths/);
    expect(() => parsePageAction({
      action: "upload", ref: "e2", paths: Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => `f${i}`),
    })).toThrow(/at most/);
  });

  it("back and forward take nothing else", () => {
    expect(parsePageAction({ action: "back", ref: "e1" })).toEqual({ action: "back" });
    expect(parsePageAction({ action: "forward" })).toEqual({ action: "forward" });
  });

  it("key: one key with up to three modifiers, optional ref", () => {
    expect(parsePageAction({ action: "key", key: "Escape" })).toEqual({ action: "key", key: "Escape" });
    expect(parsePageAction({ action: "key", key: "Control+Enter", ref: "e9" }))
      .toEqual({ action: "key", key: "Control+Enter", ref: "e9" });
    expect(parsePageAction({ action: "key", key: "Shift+Tab", ref: "" })).toEqual({ action: "key", key: "Shift+Tab" });
    for (const bad of [undefined, "", "Enter Enter", "Ctrl+c", "rm -rf", "Control+", "F13", "ab"]) {
      expect(() => parsePageAction({ action: "key", key: bad }), String(bad)).toThrow(/key/);
    }
  });

  it("dialog: accept is required; text only travels with accept", () => {
    expect(parsePageAction({ action: "dialog", accept: false, text: "x" })).toEqual({ action: "dialog", accept: false });
    expect(parsePageAction({ action: "dialog", accept: true, text: "Bob" }))
      .toEqual({ action: "dialog", accept: true, text: "Bob" });
    expect(() => parsePageAction({ action: "dialog" })).toThrow(/accept/);
    expect(() => parsePageAction({ action: "dialog", accept: "yes" })).toThrow(/accept/);
    expect(() => parsePageAction({ action: "dialog", accept: true, text: 5 })).toThrow(/text/);
  });

  it("wait: text, ref or ms; pauses and timeouts are capped", () => {
    expect(parsePageAction({ action: "wait", text: "Saved" }))
      .toEqual({ action: "wait", text: "Saved", state: "visible", timeoutMs: 10_000 });
    expect(parsePageAction({ action: "wait", text: "Loading", state: "hidden", timeoutMs: 999_999 }))
      .toEqual({ action: "wait", text: "Loading", state: "hidden", timeoutMs: MAX_WAIT_TIMEOUT_MS });
    expect(parsePageAction({ action: "wait", ref: "e3", state: "hidden" }))
      .toEqual({ action: "wait", ref: "e3", state: "hidden", timeoutMs: 10_000 });
    expect(parsePageAction({ action: "wait", ms: 60_000 })).toEqual({ action: "wait", ms: MAX_WAIT_MS });
    expect(() => parsePageAction({ action: "wait" })).toThrow(/text.*ref.*ms/);
    expect(() => parsePageAction({ action: "wait", ms: -1 })).toThrow(/wait/);
    expect(() => parsePageAction({ action: "wait", text: "x", state: "gone" })).toThrow(/state/);
    expect(() => parsePageAction({ action: "wait", text: "x", timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});

describe("keyCommits", () => {
  it("Enter and Space may send; other keys do not", () => {
    expect(keyCommits("Enter")).toBe("enter");
    expect(keyCommits("Control+Enter")).toBe("enter");
    expect(keyCommits("Space")).toBe("space");
    for (const key of ["Escape", "Tab", "Shift+Tab", "ArrowDown", "PageDown", "Control+a", "e"]) {
      expect(keyCommits(key), key).toBeNull();
    }
  });
});
