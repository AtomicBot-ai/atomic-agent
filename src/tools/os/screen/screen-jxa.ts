/**
 * The one JXA program behind every screen operation, and the argv that
 * runs it.
 *
 * The script is a constant. What it acts on (coordinates, the text to
 * type, a key code, the approved and the protected apps) travels as JSON
 * in one environment variable and is parsed inside the script, so
 * nothing the model wrote is ever spliced into script source. Positional
 * argv is avoided too: osascript reads a leading `-` as its own flag.
 *
 * Guards inside the script, right before any event is posted:
 *  - Accessibility (`AXIsProcessTrusted`) must be granted;
 *  - the approved app is brought back to the front if the approval UI
 *    took focus, and the action refuses if it cannot be;
 *  - a click hit-tests the topmost on-screen window under the point and
 *    refuses unless it belongs to the approved app;
 *  - nothing is posted into a protected app (`screen-protected.ts`).
 * `press` (ATO-530) is the exception to "brought back to the front": it
 * acts through Accessibility on one element of the approved app's
 * window, in the background, and checks the pid's bundle id instead.
 * It never posts a mouse event, so it has nothing to fall back to.
 * The TypeScript side checks the same things from the probe before it
 * asks; these are the re-checks at the moment of acting.
 */

export const SCREEN_PAYLOAD_ENV = "ATOMIC_SCREEN_PAYLOAD";

interface Pinned {
  /** The app the operator approved input for; the action refuses any other. */
  expectBundleId: string;
  /** Bundle ids the script never posts input into. */
  protectedIds: readonly string[];
}

/** Global screen points, top-left origin. */
export interface ScreenFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenOp =
  | { op: "probe"; point?: { x: number; y: number }; windows?: boolean }
  | {
      op: "windowText";
      pid: number;
      /** The captured window's title; the first window of the process when empty or not found. */
      title: string;
      /** Apps whose text is never read (`WINDOW_CAPTURE_REFUSED_BUNDLE_IDS`), re-checked by pid. */
      refusedIds: readonly string[];
      maxDepth: number;
      maxElements: number;
      maxChars: number;
    }
  | {
      op: "elements";
      pid: number;
      /** The window's title; the first window of the process when empty or not found. */
      title: string;
      /** The picked window's frame, so the walk takes that one of several same-titled windows. */
      frame?: ScreenFrame;
      /** Apps whose elements are never listed (`WINDOW_CAPTURE_REFUSED_BUNDLE_IDS`), re-checked by pid. */
      refusedIds: readonly string[];
      maxDepth: number;
      /** Elements looked at in all; the walk stops there. */
      maxScan: number;
      /** Elements kept in the list. */
      maxElements: number;
    }
  | ({
      /**
       * ATO-530: `AXPress` (or, with `value`, set `AXValue`) on one element
       * found again by its child-index path, without moving the mouse and
       * without bringing the app to the front.
       */
      op: "press";
      pid: number;
      /** The AX title of the window the list was read from; must still exist (no fallback). */
      title: string;
      /** That window's frame when listed: picks it among same-titled windows, refuses if none is there. */
      windowFrame?: ScreenFrame;
      /** The element's frame when listed: it must sit at the same place in its window. */
      frame?: ScreenFrame;
      path: readonly number[];
      /** What the list saw at `path`; anything else there is refused as changed. */
      role: string;
      name: string;
      value?: string;
    } & Pinned)
  | ({ op: "click"; x: number; y: number; button: "left" | "right"; double: boolean } & Pinned)
  | ({ op: "type"; text: string; typeVia: "keys" | "paste" } & Pinned)
  | ({ op: "key"; keyCode: number; flags: number } & Pinned);

export const SCREEN_JXA_SOURCE = String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
function appInfo(app) {
  if (!app || app.isNil()) return null;
  return { name: ObjC.unwrap(app.localizedName) || null, bundleId: ObjC.unwrap(app.bundleIdentifier) || null, pid: app.processIdentifier };
}
function frontmost() { return appInfo($.NSWorkspace.sharedWorkspace.frontmostApplication); }
function ownerAt(x, y) {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i], b = w.kCGWindowBounds;
    if (!b || w.kCGWindowAlpha === 0) continue;
    if (x >= b.X && x < b.X + b.Width && y >= b.Y && y < b.Y + b.Height) {
      var info = appInfo($.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID));
      return info || { name: w.kCGWindowOwnerName || null, bundleId: null, pid: w.kCGWindowOwnerPID };
    }
  }
  return null;
}
function listWindows() {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var apps = {}, out = [];
  for (var i = 0; i < list.length && out.length < 60; i++) {
    var w = list[i], b = w.kCGWindowBounds, pid = w.kCGWindowOwnerPID;
    if (w.kCGWindowLayer !== 0 || !b || w.kCGWindowAlpha === 0 || b.Width < 40 || b.Height < 40) continue;
    if (!(pid in apps)) apps[pid] = safe(function () { return appInfo($.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)); }, null);
    var app = apps[pid];
    out.push({ id: w.kCGWindowNumber, pid: pid, app: (app && app.name) || w.kCGWindowOwnerName || null, bundleId: app ? app.bundleId : null,
      title: w.kCGWindowName || "", x: b.X, y: b.Y, width: b.Width, height: b.Height });
  }
  return out;
}
function windowText(p) {
  var owner = safe(function () { return appInfo($.NSRunningApplication.runningApplicationWithProcessIdentifier(p.pid)); }, null);
  if (owner && owner.bundleId && isProtected({ protectedIds: p.refusedIds || [] }, owner.bundleId)) return { error: "protected" };
  var procs = Application("System Events").processes.whose({ unixId: p.pid })();
  if (!procs.length) return { error: "no-process" };
  var wins = safe(function () { return procs[0].windows(); }, []);
  var win = null;
  for (var i = 0; i < wins.length && !win; i++) if (p.title && safe(function () { return wins[i].name(); }, "") === p.title) win = wins[i];
  if (!win) win = wins[0];
  if (!win) return { error: "no-window" };
  var parts = [], seen = 0, chars = 0, cut = false;
  function walk(el, depth) {
    if (depth > p.maxDepth || seen >= p.maxElements || chars >= p.maxChars) { cut = true; return; }
    seen++;
    var role = safe(function () { return el.role(); }, "");
    // A password field is never read, not even its bullet count.
    if (role === "AXSecureTextField") return;
    var v = safe(function () { return el.value(); }, null);
    var s = typeof v === "string" ? v : "";
    if (!s && (role === "AXStaticText" || role === "AXHeading")) s = safe(function () { return el.name(); }, "") || "";
    s = String(s || "").trim();
    if (s && parts[parts.length - 1] !== s) { parts.push(s); chars += s.length + 1; }
    var kids = safe(function () { return el.uiElements(); }, []);
    for (var k = 0; k < kids.length; k++) walk(kids[k], depth + 1);
  }
  walk(win, 0);
  var text = parts.join("\n");
  if (text.length > p.maxChars) { text = text.slice(0, p.maxChars); cut = true; }
  return { text: text, truncated: cut };
}
// Roles a user acts on; containers and plain text are walked through, not listed.
var ACTIONABLE = { AXButton: 1, AXCheckBox: 1, AXRadioButton: 1, AXTextField: 1, AXTextArea: 1, AXSecureTextField: 1,
  AXSearchField: 1, AXComboBox: 1, AXPopUpButton: 1, AXMenuButton: 1, AXMenuItem: 1, AXMenuBarItem: 1, AXLink: 1,
  AXRow: 1, AXCell: 1, AXTab: 1, AXSlider: 1, AXIncrementor: 1, AXDisclosureTriangle: 1, AXColorWell: 1, AXDateField: 1 };
// Listed only when they answer AXPress (a clickable icon or label).
var PRESSABLE_IF = { AXImage: 1, AXStaticText: 1, AXGroup: 1 };
function elLabel(el) {
  var s = safe(function () { return el.name(); }, null) || safe(function () { return el.title(); }, null) ||
    safe(function () { return el.description(); }, null) || "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > 120 ? s.slice(0, 120) : s;
}
function elActions(el) {
  return safe(function () { return el.actions().map(function (a) { return String(a.name()); }); }, []);
}
function winFrame(w) {
  var pos = safe(function () { return w.position(); }, null), size = safe(function () { return w.size(); }, null);
  return pos && size ? { x: pos[0], y: pos[1], width: size[0], height: size[1] } : null;
}
function sameFrame(a, b, tol) {
  return !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}
// A title alone does not name a window: two "New Message" windows share one.
// With a frame, the window at that frame wins; strict (a press) refuses when
// several share the title and none sits there.
function findWindow(pid, title, strict, frame) {
  var procs = Application("System Events").processes.whose({ unixId: pid })();
  if (!procs.length) return { error: "no-process" };
  var wins = safe(function () { return procs[0].windows(); }, []);
  var titled = [];
  for (var i = 0; i < wins.length; i++) if (title && safe(function () { return wins[i].name(); }, "") === title) titled.push(wins[i]);
  if (frame) {
    for (var j = 0; j < titled.length; j++) if (sameFrame(winFrame(titled[j]), frame, 2)) return { win: titled[j], title: title, frame: winFrame(titled[j]) };
    // One window with that title is still that window, moved or resized;
    // several, and none at the listed frame, cannot be told apart.
    if (strict && titled.length > 1) return { error: "window-changed" };
  }
  if (strict && titled.length > 1) return { error: "window-ambiguous" };
  if (titled.length) return { win: titled[0], title: title, frame: winFrame(titled[0]) };
  if (strict && title) return { error: "no-window" };
  if (!wins[0]) return { error: "no-window" };
  return { win: wins[0], title: safe(function () { return wins[0].name(); }, "") || "", frame: winFrame(wins[0]) };
}
function listElements(p) {
  var owner = safe(function () { return appInfo($.NSRunningApplication.runningApplicationWithProcessIdentifier(p.pid)); }, null);
  if (owner && owner.bundleId && isProtected({ protectedIds: p.refusedIds || [] }, owner.bundleId)) return { error: "protected" };
  var found = findWindow(p.pid, p.title, false, p.frame || null);
  if (found.error) return found;
  var items = [], scanned = 0, cut = false;
  function walk(el, depth, path) {
    if (items.length >= p.maxElements || scanned >= p.maxScan) { cut = true; return; }
    if (depth > p.maxDepth) { cut = true; return; }
    scanned++;
    var role = depth === 0 ? "AXWindow" : (safe(function () { return el.role(); }, "") || "");
    var acts = null;
    var keep = !!ACTIONABLE[role];
    if (!keep && PRESSABLE_IF[role]) { acts = elActions(el); keep = acts.indexOf("AXPress") >= 0; }
    if (keep) {
      var pos = safe(function () { return el.position(); }, null), size = safe(function () { return el.size(); }, null);
      // Zero-sized elements are hidden (a collapsed panel, an offscreen tab); nobody could see what they do.
      if (pos && size && size[0] > 0 && size[1] > 0) {
        var item = { path: path.slice(), role: role, name: elLabel(el), x: pos[0], y: pos[1], width: size[0], height: size[1],
          actions: acts || elActions(el), enabled: safe(function () { return el.enabled(); }, true) !== false };
        // A password field is listed so it can be filled, but its value is never read.
        if (role !== "AXSecureTextField") {
          var v = safe(function () { return el.value(); }, null);
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") item.value = String(v).slice(0, 80);
        }
        items.push(item);
      }
      // Text inside a field or a secure field is not a control of its own.
      if (role === "AXTextField" || role === "AXTextArea" || role === "AXSecureTextField" || role === "AXSearchField") return;
    }
    var kids = safe(function () { return el.uiElements(); }, []);
    for (var k = 0; k < kids.length; k++) { path.push(k); walk(kids[k], depth + 1, path); path.pop(); }
  }
  walk(found.win, 0, []);
  return { elements: items, truncated: cut, scanned: scanned, windowTitle: found.title, windowFrame: found.frame };
}
function pressElement(p) {
  var owner = safe(function () { return appInfo($.NSRunningApplication.runningApplicationWithProcessIdentifier(p.pid)); }, null);
  if (!owner || !owner.bundleId || isProtected(p, owner.bundleId)) return { error: "protected" };
  if (owner.bundleId !== p.expectBundleId) return { error: "owner-mismatch" };
  var found = findWindow(p.pid, p.title, true, p.windowFrame || null);
  if (found.error) return found;
  var el = found.win;
  for (var i = 0; i < p.path.length; i++) {
    var kids = safe(function () { return el.uiElements(); }, []);
    if (!(p.path[i] < kids.length)) return { error: "element-changed" };
    el = kids[p.path[i]];
  }
  var role = safe(function () { return el.role(); }, "") || "";
  var name = elLabel(el);
  if (role !== p.role || name !== p.name) return { error: "element-changed", element: { role: role, name: name } };
  // Same role and name is not enough: a re-sorted list puts the next row's
  // "Delete" (or an unnamed icon button) at the stored path. The element must
  // also sit where it was, relative to its window (the window may move).
  if (p.frame) {
    var pos = safe(function () { return el.position(); }, null), size = safe(function () { return el.size(); }, null);
    var wf = found.frame || p.windowFrame || { x: 0, y: 0 };
    var listedWf = p.windowFrame || wf;
    var now = pos && size ? { x: pos[0] - wf.x, y: pos[1] - wf.y, width: size[0], height: size[1] } : null;
    var then = { x: p.frame.x - listedWf.x, y: p.frame.y - listedWf.y, width: p.frame.width, height: p.frame.height };
    if (!sameFrame(now, then, 4)) return { error: "element-changed", element: { role: role, name: name } };
  }
  if (typeof p.value === "string") {
    var set = safe(function () { el.value = p.value; return true; }, false);
    return set ? { did: "set-value" } : { error: "value-unsupported" };
  }
  var acts = elActions(el);
  if (acts.indexOf("AXPress") < 0) return { error: "press-unsupported", actions: acts };
  var pressed = safe(function () { el.actions.byName("AXPress").perform(); return true; }, false);
  return pressed ? { did: "press" } : { error: "press-failed", actions: acts };
}
function isProtected(p, id) {
  if (!id) return true;
  for (var i = 0; i < p.protectedIds.length; i++) if (p.protectedIds[i].toLowerCase() === String(id).toLowerCase()) return true;
  return false;
}
function bringToFront(id) {
  var front = frontmost();
  if (front && front.bundleId === id) return true;
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id);
  if (!apps || apps.count === 0) return false;
  apps.firstObject.activateWithOptions(2);
  delay(0.25);
  front = frontmost();
  return !!front && front.bundleId === id;
}
function post(e) { $.CGEventPost(0, e); }
function click(p) {
  var pt = { x: p.x, y: p.y };
  var right = p.button === "right";
  var downType = right ? 3 : 1, upType = right ? 4 : 2, button = right ? 1 : 0;
  post($.CGEventCreateMouseEvent(null, 5, pt, 0));
  delay(0.05);
  var clicks = p.double ? 2 : 1;
  for (var i = 1; i <= clicks; i++) {
    var down = $.CGEventCreateMouseEvent(null, downType, pt, button);
    $.CGEventSetIntegerValueField(down, 1, i);
    post(down);
    var up = $.CGEventCreateMouseEvent(null, upType, pt, button);
    $.CGEventSetIntegerValueField(up, 1, i);
    post(up);
    delay(0.05);
  }
}
function pressKey(code, flags) {
  var down = $.CGEventCreateKeyboardEvent(null, code, true);
  $.CGEventSetFlags(down, flags);
  post(down);
  var up = $.CGEventCreateKeyboardEvent(null, code, false);
  $.CGEventSetFlags(up, flags);
  post(up);
}
function typeChunk(chunk) {
  var down = $.CGEventCreateKeyboardEvent(null, 0, true);
  $.CGEventSetFlags(down, 0);
  $.CGEventKeyboardSetUnicodeString(down, chunk.length, chunk);
  post(down);
  var up = $.CGEventCreateKeyboardEvent(null, 0, false);
  $.CGEventSetFlags(up, 0);
  $.CGEventKeyboardSetUnicodeString(up, chunk.length, chunk);
  post(up);
  delay(0.01);
}
function savePasteboard(pb) {
  var out = [];
  var items = pb.pasteboardItems;
  if (!items || items.isNil()) return out;
  for (var i = 0; i < items.count; i++) {
    var item = items.objectAtIndex(i);
    var types = item.types;
    var copy = $.NSPasteboardItem.alloc.init;
    for (var j = 0; j < types.count; j++) {
      var type = types.objectAtIndex(j);
      var data = item.dataForType(type);
      if (data && !data.isNil()) copy.setDataForType(data, type);
    }
    out.push(copy);
  }
  return out;
}
function pasteText(text) {
  var pb = $.NSPasteboard.generalPasteboard;
  // Every item in every type (an image, files, rich text), not only plain text, comes back afterwards.
  var saved = safe(function () { return savePasteboard(pb); }, []);
  pb.clearContents;
  pb.setStringForType($(text), $.NSPasteboardTypeString);
  pressKey(9, 0x100000);
  // A busy app reads the pasteboard late; restoring too soon would paste the old clipboard instead.
  delay(0.8);
  pb.clearContents;
  if (saved.length) pb.writeObjects($(saved));
}
function typeText(text, via) {
  if (via === "paste") { pasteText(text); return "paste"; }
  var points = Array.from(text);
  var i = 0;
  try {
    for (; i < points.length; i += 16) typeChunk(points.slice(i, i + 16).join(""));
    return "keys";
  } catch (e) {
    pasteText(points.slice(i).join(""));
    return i === 0 ? "paste" : "keys+paste";
  }
}
function run() {
  var raw = $.NSProcessInfo.processInfo.environment.objectForKey("${SCREEN_PAYLOAD_ENV}");
  var p = JSON.parse(ObjC.unwrap(raw) || "{}");
  var screen = $.NSScreen.screens.objectAtIndex(0);
  var out = {
    accessibility: safe(function () { return !!$.AXIsProcessTrusted(); }, null),
    screenRecording: safe(function () { return !!$.CGPreflightScreenCaptureAccess(); }, null),
    frontmost: safe(frontmost, null),
    screen: { width: screen.frame.size.width, height: screen.frame.size.height, scale: screen.backingScaleFactor },
    done: false
  };
  if (p.op === "probe") {
    if (p.point) out.ownerAtPoint = safe(function () { return ownerAt(p.point.x, p.point.y); }, null);
    if (p.windows) out.windows = safe(listWindows, []);
    return JSON.stringify(out);
  }
  if (p.op === "windowText") {
    // Reading text posts nothing, so no app is pinned; the walk itself needs Accessibility.
    if (out.accessibility !== true) { out.error = "accessibility"; return JSON.stringify(out); }
    var read = safe(function () { return windowText(p); }, { error: "text-failed" });
    if (read.error) { out.error = read.error; return JSON.stringify(out); }
    out.text = read.text;
    out.textTruncated = read.truncated;
    out.done = true;
    return JSON.stringify(out);
  }
  if (p.op === "elements") {
    // Listing posts nothing, like windowText.
    if (out.accessibility !== true) { out.error = "accessibility"; return JSON.stringify(out); }
    var listed = safe(function () { return listElements(p); }, { error: "elements-failed" });
    if (listed.error) { out.error = listed.error; return JSON.stringify(out); }
    out.elements = listed.elements;
    out.elementsTruncated = listed.truncated;
    out.scanned = listed.scanned;
    out.windowTitle = listed.windowTitle;
    out.done = true;
    return JSON.stringify(out);
  }
  if (out.accessibility !== true) { out.error = "accessibility"; return JSON.stringify(out); }
  if (!p.expectBundleId || isProtected(p, p.expectBundleId)) { out.error = "protected"; return JSON.stringify(out); }
  if (p.op === "press") {
    // Background delivery (ATO-530): no bringToFront, no mouse event, no fallback to one.
    var r = safe(function () { return pressElement(p); }, { error: "press-failed" });
    out.frontmostAfter = safe(frontmost, null);
    if (r.element) out.element = r.element;
    if (r.actions) out.actions = r.actions;
    if (r.error) { out.error = r.error; return JSON.stringify(out); }
    out.did = r.did;
    out.done = true;
    return JSON.stringify(out);
  }
  if (!bringToFront(p.expectBundleId)) { out.frontmost = safe(frontmost, null); out.error = "not-frontmost"; return JSON.stringify(out); }
  out.frontmost = safe(frontmost, null);
  if (!out.frontmost || isProtected(p, out.frontmost.bundleId)) { out.error = "protected"; return JSON.stringify(out); }
  if (p.op === "click") {
    out.ownerAtPoint = safe(function () { return ownerAt(p.x, p.y); }, null);
    var owner = out.ownerAtPoint ? out.ownerAtPoint.bundleId : null;
    if (isProtected(p, owner)) { out.error = "protected"; return JSON.stringify(out); }
    if (owner !== p.expectBundleId) { out.error = "owner-mismatch"; return JSON.stringify(out); }
    click(p);
  } else if (p.op === "type") out.via = typeText(String(p.text), p.typeVia);
  else if (p.op === "key") pressKey(p.keyCode, p.flags);
  else { out.error = "unknown-op"; return JSON.stringify(out); }
  out.done = true;
  return JSON.stringify(out);
}
`;

export interface ScreenInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const CHILD_ENV_KEYS = ["PATH", "HOME", "LANG", "TMPDIR", "USER"] as const;

/**
 * The environment every screen child process (osascript, screencapture,
 * sips) gets: a small allow-list, never the provider keys the agent holds.
 */
export function screenChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** `osascript -l JavaScript -e <constant script>` with the operation in `ATOMIC_SCREEN_PAYLOAD`. */
export function buildScreenInvocation(
  operation: ScreenOp,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ScreenInvocation {
  const env = screenChildEnv(baseEnv);
  env[SCREEN_PAYLOAD_ENV] = JSON.stringify(operation);
  return {
    command: "osascript",
    args: ["-l", "JavaScript", "-e", SCREEN_JXA_SOURCE],
    env,
  };
}
