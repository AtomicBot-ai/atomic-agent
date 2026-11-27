import { execFile } from "node:child_process";

import type { ShowOnceApp, ShowOnceElement, ShowOnceRect } from "./show-once-log.js";

/**
 * ATO-2401 "Show once": what was under a recorded click or behind a key,
 * asked of macOS once per event through JavaScript for Automation (the
 * same NSWorkspace / CGWindowList reads as the agent's own screen script,
 * src/tools/os/screen/screen-jxa.ts):
 *
 *   click x y → the app whose window is at that point (the frontmost app
 *               for the menu bar and other windows without an app), that
 *               window's frame, and the Accessibility element at the point
 *               (its role and title or description; never its value)
 *   key       → the frontmost app and the role of the focused element, so
 *               a password field is known as one
 *
 * ATO-2499: the fallback. When the Accessibility helper
 * (native/atomic-show-once.swift, show-once-helper.ts) is in the build it
 * answers the same questions from one resident process, plus window titles
 * and menu commands; this one-osascript-per-event path runs only without it.
 *
 * Read-only: nothing is clicked, typed or captured. Every Accessibility
 * read is wrapped, so a Mac that refuses one answers without the element
 * and the step falls back to the app and the position. No electron import:
 * the parse is tested by the unit suite.
 */

export const SHOW_ONCE_PROBE_SOURCE = String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
function safe(fn, d) { try { return fn(); } catch (e) { return d; } }
function appInfo(a) {
  if (!a || a.isNil()) return null;
  return { name: ObjC.unwrap(a.localizedName) || null, bundleId: ObjC.unwrap(a.bundleIdentifier) || null, pid: a.processIdentifier };
}
function frontmost() { return safe(function () { return appInfo($.NSWorkspace.sharedWorkspace.frontmostApplication); }, null); }
function attr(el, name) {
  return safe(function () {
    var r = Ref();
    if ($.AXUIElementCopyAttributeValue(el, $(name), r) !== 0 || !r[0]) return null;
    var v = ObjC.unwrap(ObjC.castRefToObject(r[0]));
    return typeof v === "string" ? v : null;
  }, null);
}
function describe(el) {
  var role = attr(el, "AXRole");
  if (!role) return null;
  // A password field is named as one; nothing else of it is read.
  var label = role === "AXSecureTextField" ? "" : (attr(el, "AXTitle") || attr(el, "AXDescription") || "");
  return { role: role, label: String(label).slice(0, 120) };
}
function elementAt(x, y) {
  return safe(function () {
    var r = Ref();
    if ($.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), x, y, r) !== 0 || !r[0]) return null;
    return describe(r[0]);
  }, null);
}
function focused() {
  return safe(function () {
    var r = Ref();
    if ($.AXUIElementCopyAttributeValue($.AXUIElementCreateSystemWide(), $("AXFocusedUIElement"), r) !== 0 || !r[0]) return null;
    var d = describe(r[0]);
    return d ? { role: d.role, label: "" } : null;
  }, null);
}
function windowAt(x, y) {
  var list = safe(function () { return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))); }, null) || [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i], b = w.kCGWindowBounds;
    if (!b || w.kCGWindowAlpha === 0) continue;
    if (x >= b.X && x < b.X + b.Width && y >= b.Y && y < b.Y + b.Height) {
      var app = safe(function () { return appInfo($.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID)); }, null);
      if (!app || !app.bundleId) return null;
      return { app: app, window: w.kCGWindowLayer === 0 ? { x: b.X, y: b.Y, width: b.Width, height: b.Height } : null };
    }
  }
  return null;
}
function run(argv) {
  if (argv[0] === "click") {
    var x = Number(argv[1]), y = Number(argv[2]);
    var hit = windowAt(x, y);
    return JSON.stringify({ app: hit ? hit.app : frontmost(), window: hit ? hit.window : null, element: elementAt(x, y) });
  }
  return JSON.stringify({ app: frontmost(), focused: focused() });
}
`;

export interface ShowOnceProbe {
  app: ShowOnceApp | null;
  window: ShowOnceRect | null;
  element: ShowOnceElement | null;
  focused: ShowOnceElement | null;
  /** ATO-2499: the title of the window the event happened in (the Accessibility helper only; osascript gives none). */
  windowTitle: string | null;
}

const EMPTY: ShowOnceProbe = { app: null, window: null, element: null, focused: null, windowTitle: null };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, 200) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseApp(v: unknown): ShowOnceApp | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const app = { name: str(o.name), bundleId: str(o.bundleId), pid: num(o.pid) };
  return app.name || app.bundleId ? app : null;
}

function parseRect(v: unknown): ShowOnceRect | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const [x, y, width, height] = [num(o.x), num(o.y), num(o.width), num(o.height)];
  return x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0 ? { x, y, width, height } : null;
}

function parseElement(v: unknown): ShowOnceElement | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const role = str(o.role);
  if (!role) return null;
  return { role, label: role === "AXSecureTextField" ? "" : (str(o.label) ?? "") };
}

/** The script's one JSON line (or the helper's answer, already parsed); anything else is an answer that names nothing. */
export function parseShowOnceProbe(stdout: string | object): ShowOnceProbe {
  let parsed: unknown = stdout;
  if (typeof stdout !== "object") {
    try {
      parsed = JSON.parse(String(stdout || "").trim());
    } catch {
      return { ...EMPTY };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY };
  const o = parsed as Record<string, unknown>;
  return { app: parseApp(o.app), window: parseRect(o.window), element: parseElement(o.element), focused: parseElement(o.focused), windowTitle: str(o.windowTitle) };
}

export function showOnceProbeArgs(kind: "click" | "key", x = 0, y = 0): string[] {
  const base = ["-l", "JavaScript", "-e", SHOW_ONCE_PROBE_SOURCE];
  return kind === "click" ? [...base, "click", String(Math.round(x)), String(Math.round(y))] : [...base, "key"];
}

/** Runs the probe; a failure or a slow answer (3 s) is an empty probe, never a throw. */
export function runShowOnceProbe(kind: "click" | "key", x = 0, y = 0): Promise<ShowOnceProbe> {
  return new Promise((resolve) => {
    try {
      execFile("/usr/bin/osascript", showOnceProbeArgs(kind, x, y), { timeout: 3000, maxBuffer: 64 * 1024 }, (err, stdout) => {
        resolve(err ? { ...EMPTY } : parseShowOnceProbe(String(stdout)));
      });
    } catch {
      resolve({ ...EMPTY });
    }
  });
}
