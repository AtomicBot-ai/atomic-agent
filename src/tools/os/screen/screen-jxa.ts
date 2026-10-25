/**
 * The one JXA program behind every screen operation, and the argv that
 * runs it.
 *
 * The script is a constant. What it acts on (coordinates, the text to
 * type, a key code) travels as JSON in one environment variable and is
 * parsed inside the script, so nothing the model wrote is ever spliced
 * into script source: a `"` or a `);` in the text is just a character
 * to type. Positional argv is avoided on purpose too — osascript reads
 * a leading `-` in an argument as one of its own flags.
 *
 * Mouse and keyboard go through CoreGraphics events (`CGEventPost` at
 * the HID tap); the Accessibility check (`AXIsProcessTrusted`) and the
 * frontmost app (`NSWorkspace`) are answered by the same run, so the
 * permission is checked before any event is posted and an action never
 * silently does nothing.
 */

export const SCREEN_PAYLOAD_ENV = "ATOMIC_SCREEN_PAYLOAD";

export type ScreenOp =
  | { op: "probe" }
  | {
      op: "click";
      x: number;
      y: number;
      button: "left" | "right";
      double: boolean;
      expectBundleId: string | null;
    }
  | { op: "type"; text: string; expectBundleId: string | null }
  | {
      op: "key";
      keyCode: number;
      flags: number;
      expectBundleId: string | null;
    };

export const SCREEN_JXA_SOURCE = String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
function frontmost() {
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!app || app.isNil()) return null;
  return { name: ObjC.unwrap(app.localizedName) || null, bundleId: ObjC.unwrap(app.bundleIdentifier) || null };
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
function typeText(text) {
  for (var i = 0; i < text.length; i += 16) typeChunk(text.slice(i, i + 16));
}
function pressKey(code, flags) {
  var down = $.CGEventCreateKeyboardEvent(null, code, true);
  $.CGEventSetFlags(down, flags);
  post(down);
  var up = $.CGEventCreateKeyboardEvent(null, code, false);
  $.CGEventSetFlags(up, flags);
  post(up);
}
function run() {
  var raw = $.NSProcessInfo.processInfo.environment.objectForKey("${SCREEN_PAYLOAD_ENV}");
  var p = JSON.parse(ObjC.unwrap(raw) || "{}");
  var screen = $.NSScreen.mainScreen;
  var out = {
    accessibility: safe(function () { return !!$.AXIsProcessTrusted(); }, null),
    screenRecording: safe(function () { return !!$.CGPreflightScreenCaptureAccess(); }, null),
    frontmost: safe(frontmost, null),
    screen: { width: screen.frame.size.width, height: screen.frame.size.height, scale: screen.backingScaleFactor },
    done: false
  };
  if (p.op === "probe") return JSON.stringify(out);
  if (out.accessibility !== true) { out.error = "accessibility"; return JSON.stringify(out); }
  var front = out.frontmost ? out.frontmost.bundleId : null;
  if (p.expectBundleId && p.expectBundleId !== front) { out.error = "frontmost-changed"; return JSON.stringify(out); }
  if (p.op === "click") click(p);
  else if (p.op === "type") typeText(String(p.text));
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

/**
 * `osascript -l JavaScript -e <constant script>` with the operation in
 * `ATOMIC_SCREEN_PAYLOAD`. The environment is a small allow-list rather
 * than the agent's own: osascript needs a PATH and a HOME, never the
 * provider keys the agent holds.
 */
export function buildScreenInvocation(
  operation: ScreenOp,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ScreenInvocation {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "USER"]) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env[SCREEN_PAYLOAD_ENV] = JSON.stringify(operation);
  return {
    command: "osascript",
    args: ["-l", "JavaScript", "-e", SCREEN_JXA_SOURCE],
    env,
  };
}
