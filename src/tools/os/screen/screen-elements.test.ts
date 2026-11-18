import { describe, expect, it, vi } from "vitest";
import type { ApprovalGate } from "../../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../../approval/dangerous-tool.js";
import {
  buildOsScreenElementsTool,
  buildOsScreenPressTool,
  elementsRefusal,
  parseMaxElements,
} from "./screen-element-tools.js";
import {
  formatElement,
  parseElement,
  SCREEN_ELEMENT_LIMITS,
  ScreenElementStore,
  type ScreenElement,
} from "./screen-elements.js";
import { parseScreenProbe } from "./screen-host.js";
import { buildScreenInvocation, SCREEN_JXA_SOURCE, SCREEN_PAYLOAD_ENV } from "./screen-jxa.js";
import { fakeHost, screenCtx, type FakeHostOptions } from "./screen-host.fixture.js";

type Decision = { approved: boolean; reason?: string };

const TEXTEDIT = { name: "TextEdit", bundleId: "com.apple.TextEdit" };
const MAIL_WINDOW = { id: 7, pid: 501, app: "Mail", bundleId: "com.apple.mail", title: "New Message", x: 100, y: 80, width: 800, height: 600 };
const SAFARI_WINDOW = { id: 8, pid: 502, app: "Safari", bundleId: "com.apple.Safari", title: "Bank", x: 0, y: 0, width: 900, height: 700 };
const SETTINGS_WINDOW = { id: 9, pid: 503, app: "System Settings", bundleId: "com.apple.systempreferences", title: "Privacy", x: 0, y: 0, width: 700, height: 500 };
const ONEPASSWORD_WINDOW = { id: 10, pid: 504, app: "1Password", bundleId: "com.1password.1password", title: "Vault", x: 0, y: 0, width: 700, height: 500 };
const ITERM_WINDOW = { id: 11, pid: 505, app: "iTerm2", bundleId: "com.googlecode.iterm2", title: "zsh", x: 0, y: 0, width: 700, height: 500 };

const SEND: ScreenElement = { path: [0, 2], role: "AXButton", name: "Send", x: 120, y: 90, width: 60, height: 24, actions: ["AXPress"], enabled: true };
const TO: ScreenElement = { path: [1, 0], role: "AXTextField", name: "To:", value: "", x: 160, y: 130, width: 500, height: 22, actions: ["AXConfirm"], enabled: true };
const LIST_REPORT = { done: true, elements: [SEND, TO], elementsTruncated: false, scanned: 42, windowTitle: "New Message" };
/** An agent started outside any terminal, so iTerm2 is a plain terminal app, not the host. */
const NO_HOST = { PATH: "/usr/bin" };

function setup(host: FakeHostOptions = {}, decision: Decision = { approved: true }) {
  const fake = fakeHost({ windows: [MAIL_WINDOW], actionReport: LIST_REPORT, ...host });
  const request = vi.fn(async (_request: Record<string, unknown>, _options?: unknown) => decision);
  const approvals = { request } as unknown as ApprovalGate;
  const store = new ScreenElementStore();
  const options = { approvals, approvalRequired: true, deps: fake.deps, elements: store };
  return { fake, request, store, options };
}

function seed(store: ScreenElementStore, bundleId = "com.apple.mail", pid = 501, elements = [SEND, TO]) {
  store.set("s1", { bundleId, pid, windowTitle: "New Message", elements });
}

describe("element entries", () => {
  it("keeps a well-formed entry and drops malformed ones instead of guessing", () => {
    expect(parseElement({ ...SEND })).toEqual([SEND]);
    expect(parseElement({ ...SEND, path: [0, -1] })).toEqual([]);
    expect(parseElement({ ...SEND, role: "" })).toEqual([]);
    expect(parseElement({ ...SEND, width: 0 })).toEqual([]);
    expect(parseElement("button")).toEqual([]);
    const loose = parseElement({ path: [], role: "AXCheckBox", x: 1, y: 2, width: 3, height: 4, actions: ["AXPress", 7], enabled: false });
    expect(loose).toEqual([{ path: [], role: "AXCheckBox", name: "", x: 1, y: 2, width: 3, height: 4, actions: ["AXPress"], enabled: false }]);
  });

  it("formats one compact line: number, role, name, value, frame, actions, disabled", () => {
    expect(formatElement(1, SEND)).toBe('[1] button "Send" (120,90,60,24) press');
    expect(formatElement(2, { ...TO, value: "ann@example.com" })).toBe('[2] textfield "To:" value="ann@example.com" (160,130,500,22) confirm');
    expect(formatElement(3, { ...SEND, name: "", actions: [], enabled: false, x: 10.6 })).toBe("[3] button (11,90,60,24) disabled");
  });

  it("reads the elements, the press outcome and focus from the script's JSON", () => {
    const probe = parseScreenProbe(JSON.stringify({
      accessibility: true, screenRecording: true, frontmost: TEXTEDIT, screen: { width: 1440, height: 900, scale: 2 }, done: true,
      elements: [SEND, { broken: true }], elementsTruncated: true, scanned: 800, windowTitle: "New Message",
      did: "press", frontmostAfter: TEXTEDIT, element: { role: "AXButton", name: "Discard" }, actions: ["AXShowMenu", 3],
    }));
    expect(probe.elements).toEqual([SEND]);
    expect(probe).toMatchObject({ elementsTruncated: true, scanned: 800, windowTitle: "New Message", did: "press" });
    expect(probe.frontmostAfter).toEqual(TEXTEDIT);
    expect(probe.element).toEqual({ role: "AXButton", name: "Discard" });
    expect(probe.actions).toEqual(["AXShowMenu"]);
  });

  it("bounds maxElements", () => {
    expect(parseMaxElements(undefined)).toBe(SCREEN_ELEMENT_LIMITS.defaultElements);
    expect(parseMaxElements(null)).toBe(SCREEN_ELEMENT_LIMITS.defaultElements);
    expect(parseMaxElements(5000)).toBe(SCREEN_ELEMENT_LIMITS.maxElements);
    expect(() => parseMaxElements(0)).toThrow();
    expect(() => parseMaxElements(2.5)).toThrow();
  });
});

describe("ScreenElementStore", () => {
  it("keeps the last list per session and app, case-insensitively", () => {
    const store = new ScreenElementStore();
    store.set("s1", { bundleId: "com.apple.mail", pid: 1, windowTitle: "a", elements: [SEND] });
    store.set("s1", { bundleId: "com.apple.Mail", pid: 1, windowTitle: "b", elements: [TO] });
    expect(store.get("s1", "COM.APPLE.MAIL")?.windowTitle).toBe("b");
    expect(store.get("s2", "com.apple.mail")).toBeUndefined();
  });

  it("forgets the oldest app and the oldest session past its bounds", () => {
    const store = new ScreenElementStore(2, 2);
    for (const id of ["a", "b", "c"]) store.set("s1", { bundleId: id, pid: 1, windowTitle: "", elements: [] });
    expect(store.get("s1", "a")).toBeUndefined();
    expect(store.get("s1", "c")).toBeDefined();
    store.set("s2", { bundleId: "a", pid: 1, windowTitle: "", elements: [] });
    store.set("s3", { bundleId: "a", pid: 1, windowTitle: "", elements: [] });
    expect(store.get("s1", "c")).toBeUndefined();
    expect(store.get("s3", "a")).toBeDefined();
  });
});

describe("the script behind elements and press", () => {
  it("carries the element path and the text in the env payload, never in the script", () => {
    const call = buildScreenInvocation({
      op: "press", pid: 501, title: "New Message", path: [1, 0], role: "AXTextField", name: "To:", value: '"); doShellScript("x',
      expectBundleId: "com.apple.mail", protectedIds: [],
    });
    expect(call.args).toEqual(["-l", "JavaScript", "-e", SCREEN_JXA_SOURCE]);
    expect(JSON.parse(call.env[SCREEN_PAYLOAD_ENV]!)).toMatchObject({ op: "press", path: [1, 0], value: '"); doShellScript("x' });
  });

  it("presses in the background: no bring-to-front, no mouse event, no click fallback", () => {
    const pressFn = /function pressElement\(p\) \{[\s\S]*?\n\}/.exec(SCREEN_JXA_SOURCE)?.[0] ?? "";
    expect(pressFn).toContain('byName("AXPress").perform()');
    expect(pressFn).toContain('"press-unsupported"');
    for (const banned of ["bringToFront", "activateWithOptions", "CGEvent", "click("]) expect(pressFn).not.toContain(banned);
    // The press branch returns before the foreground path (bringToFront) of click / type / key.
    const run = SCREEN_JXA_SOURCE.slice(SCREEN_JXA_SOURCE.indexOf("function run()"));
    expect(run.indexOf('p.op === "press"')).toBeGreaterThan(0);
    expect(run.indexOf('p.op === "press"')).toBeLessThan(run.indexOf("bringToFront(p.expectBundleId)"));
    // A password field is listed but its value is never read.
    expect(SCREEN_JXA_SOURCE).toContain('if (role !== "AXSecureTextField")');
  });
});

describe("os.screen.elements", () => {
  it("lists a window's controls by number, asks as screen_capture, and remembers them for press", async () => {
    const { fake, request, store, options } = setup();
    const result = await buildOsScreenElementsTool(options).run({ app: "Mail" }, screenCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain('[1] button "Send" (120,90,60,24) press');
    expect(result.summary).toContain('[2] textfield "To:" (160,130,500,22) confirm');
    expect(result.summary).toContain('os.screen.press { app: "Mail", element: n }');
    expect(request.mock.calls[0]?.[0]).toMatchObject({ tool: "os.screen.elements", category: "screen_capture", affectedResources: ["app:com.apple.mail"] });
    const op = fake.ops()[1]!;
    expect(op).toMatchObject({ op: "elements", pid: 501, title: "New Message", maxElements: SCREEN_ELEMENT_LIMITS.defaultElements });
    expect(op.refusedIds).toEqual(expect.arrayContaining(["com.1password.1password"]));
    expect(store.get("s1", "com.apple.mail")).toEqual({ bundleId: "com.apple.mail", pid: 501, windowTitle: "New Message", elements: [SEND, TO] });
  });

  it("refuses browsers, blocked apps and credential windows before asking, reading nothing", async () => {
    for (const [win, appClass] of [[SAFARI_WINDOW, "browser"], [SETTINGS_WINDOW, "blocked"], [ONEPASSWORD_WINDOW, "blocked"]] as const) {
      const { fake, request, options } = setup({ windows: [win] });
      const result = await buildOsScreenElementsTool(options).run({ app: win.app }, screenCtx());
      expect(result.status, win.app).toBe("error");
      expect(result.details.reason, win.app).toBe("protected-app");
      expect(result.details.appClass, win.app).toBe(appClass);
      expect(request).not.toHaveBeenCalled();
      expect(fake.ops().map((o) => o.op)).toEqual(["probe"]);
    }
    expect(elementsRefusal("com.apple.Safari", NO_HOST)).toContain("browser.read_aria");
    expect(elementsRefusal("com.googlecode.iterm2", NO_HOST)).toBeNull();
    expect(elementsRefusal("com.apple.mail", NO_HOST)).toBeNull();
  });

  it("lists a terminal (press is a click there) and says values cannot be set", async () => {
    const { options } = setup({ windows: [ITERM_WINDOW], env: NO_HOST });
    const result = await buildOsScreenElementsTool(options).run({ app: "iTerm2" }, screenCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("setting a field's value does not");
  });

  it("names the windows on screen when none matches, and needs an app", async () => {
    const { request, options } = setup();
    const miss = await buildOsScreenElementsTool(options).run({ app: "Numbers" }, screenCtx());
    expect(miss.details.reason).toBe("no-window");
    expect(miss.summary).toContain("Mail");
    const none = await buildOsScreenElementsTool(options).run({}, screenCtx());
    expect(none.summary).toContain("`app`");
    expect(request).not.toHaveBeenCalled();
  });

  it("answers the Accessibility message without asking when it is not granted", async () => {
    const { request, options } = setup({ accessibility: false });
    const result = await buildOsScreenElementsTool(options).run({ app: "Mail" }, screenCtx());
    expect(result.details.reason).toBe("accessibility-permission");
    expect(request).not.toHaveBeenCalled();
  });

  it("reports the script's own refusal and an empty tree without storing anything", async () => {
    const refused = setup({ actionReport: { error: "protected" } });
    const r1 = await buildOsScreenElementsTool(refused.options).run({ app: "Mail" }, screenCtx());
    expect(r1.details.reason).toBe("protected-app");
    expect(refused.store.get("s1", "com.apple.mail")).toBeUndefined();
    const empty = setup({ actionReport: { done: true, elements: [], windowTitle: "New Message" } });
    const r2 = await buildOsScreenElementsTool(empty.options).run({ app: "Mail" }, screenCtx());
    expect(r2.status).toBe("ok");
    expect(r2.summary).toContain("os.screen.click");
  });

  it("is macOS-only and runs nothing elsewhere", async () => {
    const { fake, options } = setup({ platform: "linux" });
    const result = await buildOsScreenElementsTool(options).run({ app: "Mail" }, screenCtx());
    expect(result.summary).toContain("ATO-527");
    expect(fake.calls).toEqual([]);
  });
});

describe("os.screen.press", () => {
  it("presses element n in the background, pinned to the app, after a screen_control approval", async () => {
    const { fake, request, store, options } = setup({ frontmost: TEXTEDIT, actionReport: { done: true, did: "press", frontmostAfter: TEXTEDIT } });
    seed(store);
    const result = await buildOsScreenPressTool(options).run({ app: "Mail", element: 1 }, screenCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain('press button "Send" in Mail (com.apple.mail), in the background');
    expect(result.summary).not.toContain("came to the front");
    expect(result.details.mode).toBe("background");
    const ask = request.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ask).toMatchObject({ tool: "os.screen.press", category: "screen_control", reason: 'press button "Send" in Mail (com.apple.mail)', affectedResources: ["app:com.apple.mail"] });
    expect(String(ask.preview)).toContain("the mouse does not move and the app is not brought to the front");
    const ops = fake.ops();
    expect(ops.map((o) => o.op)).toEqual(["probe", "press"]);
    expect(ops[1]).toMatchObject({ op: "press", pid: 501, title: "New Message", path: [0, 2], role: "AXButton", name: "Send", expectBundleId: "com.apple.mail" });
    expect(ops[1]).not.toHaveProperty("value");
    expect(ops[1]!.protectedIds).toEqual(expect.arrayContaining(["com.apple.Safari", "io.atomicagent.desktop"]));
  });

  it("sets a text field's value, showing the whole text in the approval", async () => {
    const { fake, request, store, options } = setup({ actionReport: { done: true, did: "set-value" } });
    seed(store);
    const result = await buildOsScreenPressTool(options).run({ app: "Mail", element: "[2]", value: "ann@example.com" }, screenCtx());
    expect(result.status).toBe("ok");
    expect(String((request.mock.calls[0]?.[0] as Record<string, unknown>).preview)).toContain('"ann@example.com"');
    expect(fake.ops()[1]).toMatchObject({ op: "press", path: [1, 0], value: "ann@example.com" });
    // Setting text is typing: terminals are in the script's refusal list for it.
    expect(fake.ops()[1]!.protectedIds).toEqual(expect.arrayContaining(["com.googlecode.iterm2"]));
  });

  it("never falls back to a mouse click when the element does not answer AXPress", async () => {
    for (const error of ["press-unsupported", "press-failed"]) {
      const { fake, store, options } = setup({ actionReport: { error, actions: ["AXShowMenu"] } });
      seed(store);
      const result = await buildOsScreenPressTool(options).run({ app: "Mail", element: 1 }, screenCtx());
      expect(result.status, error).toBe("error");
      expect(result.details.reason, error).toBe("press-unsupported");
      expect(result.details.retryable, error).toBe(false);
      expect(result.summary, error).toContain("never switches to a foreground click");
      expect(result.summary, error).toContain("os.screen.click");
      expect(fake.ops().map((o) => o.op), error).toEqual(["probe", "press"]);
    }
    const { store, options } = setup({ actionReport: { error: "value-unsupported" } });
    seed(store);
    const result = await buildOsScreenPressTool(options).run({ app: "Mail", element: 2, value: "x" }, screenCtx());
    expect(result.details.reason).toBe("value-unsupported");
    expect(result.summary).toContain("os.screen.type");
  });

  it("refuses when the element at the stored path changed, and when the app was restarted", async () => {
    const changed = setup({ actionReport: { error: "element-changed", element: { role: "AXButton", name: "Discard" } } });
    seed(changed.store);
    const r1 = await buildOsScreenPressTool(changed.options).run({ app: "Mail", element: 1 }, screenCtx());
    expect(r1.details.reason).toBe("element-changed");
    expect(r1.summary).toContain('"Discard"');
    const restarted = setup();
    seed(restarted.store, "com.apple.mail", 999);
    const r2 = await buildOsScreenPressTool(restarted.options).run({ app: "Mail", element: 1 }, screenCtx());
    expect(r2.details.reason).toBe("stale-listing");
    expect(restarted.request).not.toHaveBeenCalled();
  });

  it("needs a list first and an element that is on it", async () => {
    const { request, store, options } = setup();
    const none = await buildOsScreenPressTool(options).run({ app: "Mail", element: 1 }, screenCtx());
    expect(none.details.reason).toBe("no-listing");
    seed(store);
    const out = await buildOsScreenPressTool(options).run({ app: "Mail", element: 3 }, screenCtx());
    expect(out.details.reason).toBe("no-element");
    const bad = await buildOsScreenPressTool(options).run({ app: "Mail", element: 0 }, screenCtx());
    expect(bad.status).toBe("error");
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses browsers and blocked apps for press, terminals only for value", async () => {
    for (const win of [SAFARI_WINDOW, SETTINGS_WINDOW]) {
      const { request, store, options } = setup({ windows: [win] });
      seed(store, win.bundleId, win.pid);
      const result = await buildOsScreenPressTool(options).run({ app: win.app, element: 1 }, screenCtx());
      expect(result.details.reason, win.app).toBe("protected-app");
      expect(request, win.app).not.toHaveBeenCalled();
    }
    const term = setup({ windows: [ITERM_WINDOW], env: NO_HOST, actionReport: { done: true, did: "press" } });
    seed(term.store, ITERM_WINDOW.bundleId, ITERM_WINDOW.pid);
    const press = await buildOsScreenPressTool(term.options).run({ app: "iTerm2", element: 1 }, screenCtx());
    expect(press.status).toBe("ok");
    const typed = await buildOsScreenPressTool(term.options).run({ app: "iTerm2", element: 2, value: "rm -rf ~" }, screenCtx());
    expect(typed.details.reason).toBe("protected-app");
    expect(typed.details.appClass).toBe("terminal");
    expect(term.request).toHaveBeenCalledTimes(1);
  });

  it("presses nothing when the user declines", async () => {
    const { fake, store, options } = setup({}, { approved: false, reason: "no" });
    seed(store);
    await expect(buildOsScreenPressTool(options).run({ app: "Mail", element: 1 }, screenCtx())).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(fake.ops().map((o) => o.op)).toEqual(["probe"]);
  });

  it("says so when the app raised itself in response", async () => {
    const { store, options } = setup({ frontmost: TEXTEDIT, actionReport: { done: true, did: "press", frontmostAfter: { name: "Mail", bundleId: "com.apple.mail" } } });
    seed(store);
    const result = await buildOsScreenPressTool(options).run({ app: "Mail", element: 1 }, screenCtx());
    expect(result.summary).toContain("came to the front on its own");
  });
});
