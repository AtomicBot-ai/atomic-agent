/**
 * A window's controls as a short numbered list (ATO-998 item 2), and the
 * per-session memory that lets `os.screen.press { element: n }` (ATO-530)
 * name one of them later.
 *
 * Pixels are hard for a 4–9B model: it has to find a button in a
 * screenshot and hand back exact coordinates. The Accessibility tree
 * already knows every button, field and checkbox with its name, so the
 * model gets the same kind of list the browser tool's ARIA snapshot gives
 * (`[n] role "name"`), and acts by number. Only controls are listed
 * (buttons, fields, checkboxes, menu items, links, rows...); containers
 * and plain text are walked through. A password field is listed (so it
 * can be filled) but its value is never read.
 *
 * Each entry keeps the child-index path the walk took from the window,
 * plus the role and name it saw there. A press walks the same path again
 * and refuses unless the same role and name are still there: the window
 * may have changed in between, and a different control must never be
 * pressed in its place.
 */

export interface ScreenElement {
  /** Child indices from the window down to the element (`uiElements()` order). */
  path: number[];
  /** AX role as macOS names it: `AXButton`, `AXTextField`, ... */
  role: string;
  /** Name, title or description, whitespace folded, at most 120 chars (the press re-check compares this). */
  name: string;
  /** Current value, at most 80 chars; never set for a password field. */
  value?: string;
  /** Global screen points, top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** AX actions it answers: `AXPress`, `AXShowMenu`, `AXIncrement`, ... */
  actions: string[];
  enabled: boolean;
}

/** Limits of the Accessibility walk behind `os.screen.elements`. */
export const SCREEN_ELEMENT_LIMITS = {
  maxDepth: 14,
  /** Elements looked at in all (each one is a few Apple Events). */
  maxScan: 800,
  /** Listed by default: enough for a dialog or a toolbar, short for a small model. */
  defaultElements: 60,
  /** Most a caller may ask for. */
  maxElements: 200,
} as const;

/** One element entry; a malformed one is dropped, not guessed. */
export function parseElement(raw: unknown): ScreenElement[] {
  if (!raw || typeof raw !== "object") return [];
  const e = raw as Record<string, unknown>;
  if (!Array.isArray(e.path) || !e.path.every((i) => Number.isInteger(i) && (i as number) >= 0)) return [];
  if (typeof e.role !== "string" || e.role.length === 0) return [];
  const nums = [e.x, e.y, e.width, e.height].map(Number);
  if (!nums.every(Number.isFinite) || !(nums[2]! > 0) || !(nums[3]! > 0)) return [];
  const [x, y, width, height] = nums as [number, number, number, number];
  return [
    {
      path: [...(e.path as number[])],
      role: e.role,
      name: typeof e.name === "string" ? e.name : "",
      ...(typeof e.value === "string" ? { value: e.value } : {}),
      x,
      y,
      width,
      height,
      actions: Array.isArray(e.actions) ? e.actions.filter((a): a is string => typeof a === "string") : [],
      enabled: e.enabled !== false,
    },
  ];
}

/** `AXPopUpButton` → `popupbutton`; `AXShowMenu` → `showmenu`. */
function shortAx(name: string): string {
  return (name.startsWith("AX") ? name.slice(2) : name).toLowerCase();
}

/**
 * `[3] button "Save" (812,440,60,24) press` — one line per element:
 * number, role, name, value when there is one, the frame in screen
 * points, the actions, and `disabled` when it is greyed out.
 */
export function formatElement(n: number, el: ScreenElement): string {
  const parts = [`[${n}]`, shortAx(el.role)];
  if (el.name) parts.push(JSON.stringify(el.name));
  if (el.value !== undefined && el.value !== "") parts.push(`value=${JSON.stringify(el.value)}`);
  parts.push(`(${[el.x, el.y, el.width, el.height].map((v) => Math.round(v)).join(",")})`);
  if (el.actions.length > 0) parts.push(el.actions.map(shortAx).join(","));
  if (!el.enabled) parts.push("disabled");
  return parts.join(" ");
}

export function formatElements(elements: readonly ScreenElement[]): string {
  return elements.map((el, i) => formatElement(i + 1, el)).join("\n");
}

/** What `os.screen.elements` read from one app's window, kept for `os.screen.press`. */
export interface ElementListing {
  bundleId: string;
  pid: number;
  /** The AX title of the window that was walked: the press looks for exactly this window. */
  windowTitle: string;
  /** `elements[n - 1]` is element n. */
  elements: ScreenElement[];
}

/**
 * The last listing per session and app, so a press names `element: 3`
 * without echoing the path. A new listing of the same app replaces the
 * old one; sessions and apps are bounded like `ScreenGeometryStore`.
 */
export class ScreenElementStore {
  private readonly bySession = new Map<string, Map<string, ElementListing>>();

  constructor(
    private readonly maxSessions = 64,
    private readonly maxAppsPerSession = 8,
  ) {}

  set(sessionId: string, listing: ElementListing): void {
    const apps = this.bySession.get(sessionId) ?? new Map<string, ElementListing>();
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, apps);
    const key = listing.bundleId.toLowerCase();
    apps.delete(key);
    apps.set(key, listing);
    while (apps.size > this.maxAppsPerSession) {
      const oldest = apps.keys().next().value;
      if (oldest === undefined) break;
      apps.delete(oldest);
    }
    while (this.bySession.size > this.maxSessions) {
      const oldest = this.bySession.keys().next().value;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
    }
  }

  get(sessionId: string, bundleId: string): ElementListing | undefined {
    return this.bySession.get(sessionId)?.get(bundleId.toLowerCase());
  }
}
