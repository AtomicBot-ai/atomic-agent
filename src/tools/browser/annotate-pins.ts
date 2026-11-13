/**
 * Pins read back from the annotate overlay (ATO-518): checked, grouped by
 * the part of the page they sit in, and rendered for the model.
 *
 * Grouping: each pin carries the selector path from the top of the page
 * (or the nearest element with a unique id) down to its element, and the
 * depth of its "region", the nearest landmark around it (main, section,
 * article, header, footer, nav, aside, form, dialog or a matching role),
 * else the first level under the root. Pins whose regions nest are one
 * group: edits inside one group touch the same DOM subtree, edits in
 * different groups can be handed to parallel workers.
 */

export interface PinRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationPin {
  id: number;
  /** The user's own words, typed in the overlay. */
  comment: string;
  selector: string;
  tag: string;
  /** Visible text of the element, cut short (page text). */
  text: string;
  /** Box in CSS pixels from the top-left of the document. */
  rect: PinRect;
  styles: Record<string, string>;
  /** Selector parts from the outermost ancestor read to the element. */
  path: string[];
  /** Index in `path` of the pin's region. */
  regionDepth: number;
  /** The element is still on the page (the box is current). */
  attached: boolean;
}

export interface PinGroup {
  /** Selector of the region the group's pins share. */
  region: string;
  pinIds: number[];
}

const CAPS = {
  pins: 50,
  comment: 2_000,
  selector: 500,
  tag: 40,
  text: 160,
  styleValue: 200,
  styles: 24,
  pathParts: 30,
  pathPart: 200,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/** The pins the page script returned, with every field checked and capped. */
export function sanitizePins(raw: readonly unknown[]): AnnotationPin[] {
  const pins: AnnotationPin[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (pins.length >= CAPS.pins) break;
    if (!isRecord(entry)) continue;
    const id = num(entry.id);
    const comment = text(entry.comment, CAPS.comment);
    if (id <= 0 || seen.has(id) || comment.length === 0) continue;
    seen.add(id);
    const rect = isRecord(entry.rect) ? entry.rect : {};
    const styles: Record<string, string> = {};
    if (isRecord(entry.styles)) {
      for (const [key, value] of Object.entries(entry.styles).slice(0, CAPS.styles)) {
        if (/^[a-z-]{1,40}$/.test(key) && typeof value === "string") styles[key] = text(value, CAPS.styleValue);
      }
    }
    const path = Array.isArray(entry.path)
      ? entry.path.slice(-CAPS.pathParts).map((part) => text(part, CAPS.pathPart)).filter((part) => part.length > 0)
      : [];
    pins.push({
      id,
      comment,
      selector: text(entry.selector, CAPS.selector),
      tag: text(entry.tag, CAPS.tag).toLowerCase(),
      text: text(entry.text, CAPS.text),
      rect: { x: num(rect.x), y: num(rect.y), width: Math.max(0, num(rect.width)), height: Math.max(0, num(rect.height)) },
      styles,
      path,
      regionDepth: Math.min(Math.max(0, num(entry.regionDepth)), Math.max(0, path.length - 1)),
      attached: entry.attached === true,
    });
  }
  return pins.sort((a, b) => a.id - b.id);
}

function regionPath(pin: AnnotationPin): string[] {
  return pin.path.slice(0, pin.regionDepth + 1);
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, i) => path[i] === part);
}

/**
 * Pins grouped by shared DOM subtree. A pin joins the group whose region
 * contains its own region (or its element); groups come out in the order
 * of their first pin.
 */
export function groupPins(pins: readonly AnnotationPin[]): PinGroup[] {
  const ordered = [...pins].sort(
    (a, b) => regionPath(a).length - regionPath(b).length || a.id - b.id,
  );
  const groups: Array<{ region: string[]; pinIds: number[] }> = [];
  for (const pin of ordered) {
    const own = regionPath(pin);
    const home = groups.find((group) => startsWith(pin.path, group.region) || startsWith(group.region, own));
    if (home) {
      home.pinIds.push(pin.id);
      // One region inside the other: the group keeps the outer one.
      if (own.length < home.region.length) home.region = own;
    } else {
      groups.push({ region: own, pinIds: [pin.id] });
    }
  }
  return groups
    .map((group) => ({ region: group.region.join(" > ") || "(page)", pinIds: group.pinIds.sort((a, b) => a - b) }))
    .sort((a, b) => (a.pinIds[0] ?? 0) - (b.pinIds[0] ?? 0));
}

const STYLES_SHOWN = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "font-family",
  "padding",
  "margin",
  "border-radius",
  "display",
] as const;

/** One pin's lines; `crop` is the saved element picture, if any. */
export function renderPin(pin: AnnotationPin, crop?: string): string[] {
  const label = pin.text ? ` "${pin.text}"` : "";
  const styles = STYLES_SHOWN.filter((key) => pin.styles[key] !== undefined)
    .map((key) => `${key}: ${pin.styles[key]}`)
    .join("; ");
  const lines = [
    `  [${pin.id}] comment: ${pin.comment}`,
    `      element: <${pin.tag || "?"}>${label}${pin.attached ? "" : " (no longer on the page; details as when pinned)"}`,
    `      selector: ${pin.selector || "(none)"}`,
    `      box: ${pin.rect.width}x${pin.rect.height} at (${pin.rect.x}, ${pin.rect.y}) in the document`,
  ];
  if (styles) lines.push(`      styles: ${styles}`);
  if (crop) lines.push(`      crop: ${crop}`);
  return lines;
}
