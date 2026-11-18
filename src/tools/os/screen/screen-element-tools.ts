import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";
import {
  formatElement,
  formatElements,
  SCREEN_ELEMENT_LIMITS,
  type ScreenElement,
  type ScreenElementStore,
} from "./screen-elements.js";
import {
  accessibilityMessage,
  macOnlyMessage,
  runScreenOp,
  type ScreenApp,
  type ScreenDeps,
  type ScreenProbe,
} from "./screen-host.js";
import { previewText, SCREEN_TYPE_MAX_CHARS } from "./screen-input.js";
import {
  protectedAppReason,
  protectedBundleIds,
  screenAppClass,
  type ScreenInputKind,
} from "./screen-protected.js";
import {
  describeWindows,
  parseWindowQuery,
  pickWindow,
  WINDOW_CAPTURE_REFUSED_BUNDLE_IDS,
  windowCaptureRefusal,
  windowLabel,
  type ScreenWindow,
  type WindowQuery,
} from "./screen-window.js";

export const OS_SCREEN_ELEMENTS_TOOL = "os.screen.elements";
export const OS_SCREEN_PRESS_TOOL = "os.screen.press";

// Room for a full list (200 lines of ~70 chars) with its header and footer.
const SCREEN_RESULT_OPTIONS = { maxSummaryLength: 16_000, maxTailLines: 240 } as const;

export interface OsScreenElementOptions extends DangerousToolOptions {
  deps: ScreenDeps;
  elements: ScreenElementStore;
}

/**
 * `os.screen.elements { app, window?, maxElements? }` (ATO-998 item 2):
 * the controls of one app window as a numbered list, read through
 * Accessibility. Read-only: it posts nothing and asks as `screen_capture`,
 * like a window snapshot with its text.
 *
 * Listed only where `os.screen.press` could act, so the list never
 * invites a press that is then refused: credential and login windows
 * (`WINDOW_CAPTURE_REFUSED_BUNDLE_IDS`) are never read at all, and the
 * blocked apps (the agent itself, settings, script runners) and web
 * browsers (the browser tool's ARIA snapshot is the list there) are
 * refused with the reason. Terminals and code editors are listed: a
 * press there is a click, which they take.
 */
export function buildOsScreenElementsTool(options: OsScreenElementOptions): ToolDefinition {
  const { deps } = options;
  const name = OS_SCREEN_ELEMENTS_TOOL;
  return {
    name,
    description:
      "List the controls of one app window (macOS) as numbered lines: `[n] role \"name\" value? (x,y,w,h) actions`. Read through Accessibility, no screenshot needed; then press one with os.screen.press { app, element: n } in the background. May ask the user first.",
    readonly: true,
    async run(rawArgs, ctx) {
      if (deps.platform !== "darwin") return result(name, "error", macOnlyMessage(name, deps.platform));
      let query: WindowQuery;
      let limit: number;
      try {
        query = requireAppQuery(rawArgs);
        limit = parseMaxElements(rawArgs.maxElements);
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      let found: { probe: ScreenProbe; target: ScreenWindow } | CompressedToolResult;
      try {
        found = await findTarget(name, deps, query, ctx);
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      if ("status" in found) return found;
      const { target } = found;
      const bundleId = target.bundleId;
      const refusal = elementsRefusal(bundleId, deps.env);
      if (refusal !== null || !bundleId) {
        return result(name, "error", `${name} refused (${windowLabel(target)}): ${refusal ?? "the app could not be identified"}. Nothing was read.`, {
          retryable: false,
          reason: "protected-app",
          appClass: screenAppClass(bundleId, deps.env),
        });
      }
      const label = windowLabel(target);
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: name,
          category: "screen_capture",
          reason: `list the controls of the window ${label}`,
          preview: `${name}: the buttons, fields and other controls of one window, read through Accessibility (password values are never read)\nwindow: ${label}`,
          affectedResources: [`app:${bundleId}`],
        },
        ctx.signal,
      );
      let report: ScreenProbe;
      try {
        report = await runScreenOp(
          deps,
          {
            op: "elements",
            pid: target.pid,
            title: target.title,
            refusedIds: WINDOW_CAPTURE_REFUSED_BUNDLE_IDS,
            maxDepth: SCREEN_ELEMENT_LIMITS.maxDepth,
            maxScan: SCREEN_ELEMENT_LIMITS.maxScan,
            maxElements: limit,
          },
          ctx,
        );
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      if (report.error === "accessibility") return permissionResult(name, deps);
      if (report.error === "protected") {
        return result(name, "error", `${name} refused: ${label} holds passwords or login prompts. Nothing was read.`, { retryable: false, reason: "protected-app" });
      }
      if (report.error || !report.elements) {
        return result(name, "error", `${name} read nothing (${report.error ?? "no list"}). The window may have closed; os.screen.capture { app } shows it as a picture.`, { reason: report.error ?? "no-list" });
      }
      const elements = report.elements;
      options.elements.set(ctx.sessionId, {
        bundleId,
        pid: target.pid,
        windowTitle: report.windowTitle ?? target.title,
        elements,
      });
      return listingResult(name, label, target, bundleId, elements, report, deps.env);
    },
  };
}

function listingResult(
  name: string,
  label: string,
  target: ScreenWindow,
  bundleId: string,
  elements: readonly ScreenElement[],
  report: ScreenProbe,
  env: NodeJS.ProcessEnv,
): CompressedToolResult {
  const app = target.app ?? bundleId;
  const details = {
    app: target.app,
    bundleId,
    window: report.windowTitle ?? target.title,
    count: elements.length,
    truncated: report.elementsTruncated === true,
    scanned: report.scanned,
  };
  if (elements.length === 0) {
    return result(
      name,
      "ok",
      `the window ${label} exposes no controls through Accessibility (some apps draw their own). Use os.screen.capture { app: ${JSON.stringify(app)} } and os.screen.click instead.`,
      details,
    );
  }
  const terminal = screenAppClass(bundleId, env) === "terminal";
  const lines = [
    `${elements.length} controls in the window ${label}, numbered for os.screen.press { app: ${JSON.stringify(app)}, element: n }` +
      ` (frames are x,y,width,height in screen points):`,
    formatElements(elements),
  ];
  if (report.elementsTruncated === true) {
    lines.push("The list stops early (window too large); pass a larger maxElements, or name a smaller window.");
  }
  lines.push(
    terminal
      ? "This is a terminal or code editor: press works, setting a field's value does not (use os.shell.run)."
      : "Press runs in the background: the mouse does not move and the app is not brought to the front. `value` fills a text field.",
  );
  return result(name, "ok", lines.join("\n"), details);
}

/**
 * `os.screen.press { app, window?, element, value? }` (ATO-530): act on
 * element n of the session's last `os.screen.elements` list for that
 * app, in the background. Without `value` it performs `AXPress`; with
 * `value` it sets the element's `AXValue` (a text field). The mouse
 * does not move and the app is not brought to the front, so the user
 * can keep working in another app.
 *
 * Same rules as click and type (`screen-protected.ts`): a press is a
 * click (refused in browsers and the blocked apps, allowed in terminals),
 * setting a value is typing (refused in terminals too). The same
 * `screen_control` approval names the element and the app. At action
 * time the script checks the pid still belongs to the approved app,
 * walks the stored path again and refuses unless the same role and name
 * are there.
 *
 * Never a silent change of delivery mode (Hermes' cua-driver rule): an
 * element that does not answer `AXPress`, or a value that cannot be set,
 * is a refusal that names `os.screen.click` / `os.screen.type`, which
 * bring the app to the front and move the mouse, under their own
 * approval. Nothing here ever posts a mouse event.
 */
export function buildOsScreenPressTool(options: OsScreenElementOptions): ToolDefinition {
  const { deps } = options;
  const name = OS_SCREEN_PRESS_TOOL;
  return {
    name,
    description:
      "Press element n from the last os.screen.elements list of that app (macOS), or with `value` set a text field's text, in the background: the mouse does not move and the app stays where it is. Asks the user first; never in a web browser, the agent itself, settings or a password manager; no `value` in terminals or code editors.",
    readonly: false,
    async run(rawArgs, ctx) {
      if (deps.platform !== "darwin") return result(name, "error", macOnlyMessage(name, deps.platform));
      let query: WindowQuery;
      let n: number;
      let value: string | undefined;
      try {
        query = requireAppQuery(rawArgs);
        n = parseElementNumber(rawArgs.element);
        value = parseValue(rawArgs.value);
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      const kind: ScreenInputKind = value === undefined ? "click" : "type";
      let found: { probe: ScreenProbe; target: ScreenWindow } | CompressedToolResult;
      try {
        found = await findTarget(name, deps, query, ctx);
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      if ("status" in found) return found;
      const { probe, target } = found;
      const bundleId = target.bundleId;
      const refusal = protectedAppReason(bundleId, deps.env, kind);
      if (refusal !== null || !bundleId) {
        return refusedResult(name, windowLabel(target), refusal ?? "the target app could not be identified", {
          element: n,
          appClass: screenAppClass(bundleId, deps.env),
        });
      }
      const listing = options.elements.get(ctx.sessionId, bundleId);
      if (!listing) {
        return result(name, "error", `${name}: there is no element list for ${windowLabel(target)} in this session. Call os.screen.elements { app: ${JSON.stringify(target.app ?? bundleId)} } first, then press by its numbers.`, { reason: "no-listing" });
      }
      if (listing.pid !== target.pid) {
        return result(name, "error", `${name} did nothing: ${windowLabel(target)} was restarted since the list was read. Call os.screen.elements again.`, { reason: "stale-listing" });
      }
      const el = listing.elements[n - 1];
      if (!el) {
        return result(name, "error", `${name}: the last list of ${windowLabel(target)} has elements 1-${listing.elements.length}, not ${n}.`, { reason: "no-element", count: listing.elements.length });
      }
      const app = describeApp({ name: target.app, bundleId });
      const what = formatElement(n, el);
      const summary = value === undefined
        ? `press ${shortName(el)}`
        : `set ${shortName(el)} to ${JSON.stringify(value)}`;
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: name,
          category: "screen_control",
          reason: `${summary} in ${app}`,
          preview: [
            `${name}: ${summary}`,
            `element: ${what}`,
            `window: ${listing.windowTitle ? JSON.stringify(listing.windowTitle) : "(untitled)"} of ${app}`,
            ...(value === undefined ? [] : [previewText(value)]),
            "in the background: the mouse does not move and the app is not brought to the front",
          ].join("\n"),
          affectedResources: [`app:${bundleId}`],
        },
        ctx.signal,
      );
      let after: ScreenProbe;
      try {
        after = await runScreenOp(
          deps,
          {
            op: "press",
            pid: listing.pid,
            title: listing.windowTitle,
            path: el.path,
            role: el.role,
            name: el.name,
            ...(value === undefined ? {} : { value }),
            expectBundleId: bundleId,
            protectedIds: protectedBundleIds(deps.env, kind),
          },
          ctx,
        );
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      return pressResult(name, { n, el, app, summary, value, before: probe.frontmost }, after, deps);
    },
  };
}

interface PressAttempt {
  n: number;
  el: ScreenElement;
  app: string;
  summary: string;
  value: string | undefined;
  before: ScreenApp | null;
}

function pressResult(
  name: string,
  attempt: PressAttempt,
  after: ScreenProbe,
  deps: ScreenDeps,
): CompressedToolResult {
  const { n, el, app, summary, value } = attempt;
  const details: Record<string, unknown> = {
    element: n,
    role: el.role,
    name: el.name,
    mode: "background",
    ...(value === undefined ? {} : { chars: value.length }),
    frontmost: after.frontmostAfter ?? after.frontmost,
  };
  const relist = "Call os.screen.elements again and press by the new numbers.";
  switch (after.error) {
    case undefined:
      break;
    case "accessibility":
      return permissionResult(name, deps);
    case "protected":
      return refusedResult(name, app, `the element belongs to an app screen control may not ${value === undefined ? "click" : "type"} into`, details);
    case "owner-mismatch":
      return result(name, "error", `${name} did nothing: that process is no longer ${app}. ${relist}`, { ...details, reason: "owner-mismatch" });
    case "no-window":
    case "no-process":
      return result(name, "error", `${name} did nothing: the window the list was read from is gone. ${relist}`, { ...details, reason: "no-window" });
    case "element-changed": {
      const now = after.element ? ` (now: ${after.element.role || "nothing"} ${JSON.stringify(after.element.name)})` : "";
      return result(name, "error", `${name} did nothing: element ${n} is no longer ${shortName(el)}${now}; the window changed. ${relist}`, { ...details, reason: "element-changed" });
    }
    case "press-unsupported":
    case "press-failed":
    case "value-unsupported":
      return noBackgroundResult(name, attempt, after, details);
    default:
      return result(name, "error", `${name} did nothing: ${after.error}`, details);
  }
  if (!after.done) return result(name, "error", `${name} did nothing: the script reported no action`, details);
  const raised =
    attempt.before?.bundleId && after.frontmostAfter?.bundleId && after.frontmostAfter.bundleId !== attempt.before.bundleId
      ? ` Note: ${describeApp(after.frontmostAfter)} came to the front on its own in response.`
      : "";
  return result(
    name,
    "ok",
    `${summary} in ${app}, in the background (mouse and focus untouched).${raised} The window may have changed: os.screen.elements or os.screen.capture shows the result.`,
    details,
  );
}

/**
 * The refusal that replaces a silent fallback. A foreground action
 * (a real click or typed keys) moves the user's mouse and focus, so it
 * is never taken on the model's behalf here: the model has to choose it,
 * and the user approves it again.
 */
function noBackgroundResult(
  name: string,
  attempt: PressAttempt,
  after: ScreenProbe,
  details: Record<string, unknown>,
): CompressedToolResult {
  const { el, app, value } = attempt;
  const answers = after.actions && after.actions.length > 0 ? ` (it answers: ${after.actions.join(", ")})` : "";
  const why = after.error === "value-unsupported"
    ? `${shortName(el)} in ${app} does not take a value through Accessibility`
    : after.error === "press-failed"
      ? `${app} rejected AXPress on ${shortName(el)}`
      : `${shortName(el)} in ${app} does not support AXPress${answers}`;
  const instead = value === undefined
    ? "os.screen.capture { app } and then os.screen.click on it"
    : "os.screen.click on the field and then os.screen.type";
  return result(
    name,
    "error",
    `${name} refused: ${why}, so it cannot be done in the background. Nothing was clicked or typed: ` +
      `screen control never switches to a foreground click or keystrokes on its own. If moving the mouse and bringing ${app} ` +
      `to the front is acceptable, use ${instead} (it asks the user again).`,
    { ...details, retryable: false, reason: after.error === "value-unsupported" ? "value-unsupported" : "press-unsupported", frame: { x: el.x, y: el.y, width: el.width, height: el.height } },
  );
}

/** `button "Save"`, or just `button` when it has no name. */
function shortName(el: ScreenElement): string {
  const role = (el.role.startsWith("AX") ? el.role.slice(2) : el.role).toLowerCase();
  return el.name ? `${role} ${JSON.stringify(el.name)}` : role;
}

/**
 * Why the controls of this app are not listed, or `null` when they are:
 * the credential windows are never read, and the apps where a press is
 * refused anyway are not listed either.
 */
export function elementsRefusal(bundleId: string | null | undefined, env: NodeJS.ProcessEnv): string | null {
  const credentials = windowCaptureRefusal(bundleId);
  if (credentials) return credentials;
  const cls = screenAppClass(bundleId, env);
  if (cls === null) return "the app could not be identified";
  if (cls === "browser") {
    return `${bundleId} is a web browser; read its page with the browser tool (browser.read_aria gives the numbered list there)`;
  }
  if (cls === "blocked") return protectedAppReason(bundleId, env, "click");
  return null;
}

/** Probe the on-screen windows and pick the one the query means. */
async function findTarget(
  name: string,
  deps: ScreenDeps,
  query: WindowQuery,
  ctx: ToolContext,
): Promise<{ probe: ScreenProbe; target: ScreenWindow } | CompressedToolResult> {
  const probe = await runScreenOp(deps, { op: "probe", windows: true }, ctx);
  if (probe.accessibility === false) return permissionResult(name, deps);
  const windows = probe.windows ?? [];
  const target = pickWindow(windows, query);
  if (!target) {
    return result(
      name,
      "error",
      `no on-screen window matches ${describeQuery(query)}. Windows on screen, front to back:\n${describeWindows(windows)}\n` +
        "Call again with `app` set to one of these app names (and `window` to part of its title when it has several).",
      { reason: "no-window", windows: windows.slice(0, 20).map(windowLabel) },
    );
  }
  return { probe, target };
}

function requireAppQuery(args: Record<string, unknown>): WindowQuery {
  const query = parseWindowQuery(args);
  if (!query?.app) throw new Error("`app` (an app name or bundle id) is required");
  return query;
}

export function parseMaxElements(raw: unknown): number {
  if (raw === undefined || raw === null) return SCREEN_ELEMENT_LIMITS.defaultElements;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error("`maxElements` must be a whole number >= 1");
  }
  return Math.min(raw, SCREEN_ELEMENT_LIMITS.maxElements);
}

function parseElementNumber(raw: unknown): number {
  // A small model may send "3" or "[3]" for element 3.
  const n = typeof raw === "string" ? Number(raw.trim().replace(/^\[(\d+)\]$/, "$1")) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new Error("`element` must be the number n of a line `[n]` from os.screen.elements");
  }
  return n;
}

function parseValue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error("`value` must be a string");
  if (raw.length > SCREEN_TYPE_MAX_CHARS) {
    throw new Error(`\`value\` is ${raw.length} characters; at most ${SCREEN_TYPE_MAX_CHARS} per call`);
  }
  return raw;
}

function describeQuery(query: WindowQuery): string {
  const parts = [];
  if (query.app) parts.push(`app "${query.app}"`);
  if (query.window) parts.push(`title containing "${query.window}"`);
  return parts.join(" and ");
}

function describeApp(app: ScreenApp | null | undefined): string {
  if (!app || (!app.name && !app.bundleId)) return "an unknown app";
  if (app.name && app.bundleId) return `${app.name} (${app.bundleId})`;
  return app.name ?? app.bundleId ?? "an unknown app";
}

function refusedResult(
  tool: string,
  what: string,
  why: string,
  details: Record<string, unknown>,
): CompressedToolResult {
  return result(
    tool,
    "error",
    `${tool} refused (${what}): ${why}. Screen control never presses into a web browser, Atomic Agent itself, ` +
      "system settings, the keychain or a password manager, and never sets text in a terminal or code editor, at any " +
      "approval level. Do not retry through screen control; use the tool named above, or tell the user to do this step themselves.",
    { ...details, retryable: false, reason: "protected-app" },
  );
}

function permissionResult(tool: string, deps: ScreenDeps): CompressedToolResult {
  return result(tool, "error", accessibilityMessage(deps.env), {
    retryable: false,
    reason: "accessibility-permission",
  });
}

function result(
  tool: string,
  status: "ok" | "error",
  output: string,
  details: Record<string, unknown> = {},
): CompressedToolResult {
  return compressToolResult({ tool, status, output, details }, SCREEN_RESULT_OPTIONS);
}
