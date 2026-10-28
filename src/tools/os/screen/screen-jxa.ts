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

export type ScreenOp =
  | { op: "probe"; point?: { x: number; y: number } }
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
    return JSON.stringify(out);
  }
  if (out.accessibility !== true) { out.error = "accessibility"; return JSON.stringify(out); }
  if (!p.expectBundleId || isProtected(p, p.expectBundleId)) { out.error = "protected"; return JSON.stringify(out); }
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
