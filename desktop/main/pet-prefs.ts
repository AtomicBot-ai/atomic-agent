/**
 * ATO-2391: the desktop pet's settings and where its window goes. Pure
 * apart from the file read and write (no Electron import).
 *
 * The choice lives in userData (pet.json), like voice.json and
 * background.json: it is about this app on this computer, not the agent,
 * so the agent's config and its schema version are untouched. Off by
 * default; View › Desktop Pet turns it on.
 *
 *   enabled  the pet window shows
 *   dnd      do not disturb: no bubble, no done / error flashes
 *   x, y     where the person dragged it (DIP, the window's top left);
 *            null until then
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PetPrefs {
  enabled: boolean;
  dnd: boolean;
  x: number | null;
  y: number | null;
}

export const PET_FILE = "pet.json";
export const PET_DEFAULTS: Readonly<PetPrefs> = { enabled: false, dnd: false, x: null, y: null };

/** The window's size in DIP: the sprite at the bottom, room for the bubble above it. */
export const PET_SIZE = { width: 240, height: 260 } as const;
/** How far from the work area's corner the pet starts. */
export const PET_MARGIN = 24;

const COORD_MAX = 100_000;

function coord(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= COORD_MAX ? Math.round(v) : null;
}

/** Whatever pet.json held → valid settings; anything wrong reads as the default. */
export function parsePetPrefs(raw: unknown): PetPrefs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const x = coord(o.x);
  const y = coord(o.y);
  return {
    enabled: o.enabled === true,
    dnd: o.dnd === true,
    // A position is both numbers or neither.
    x: x !== null && y !== null ? x : null,
    y: x !== null && y !== null ? y : null,
  };
}

/** A change from the menu or a drag; unknown keys and bad values are ignored. */
export function mergePetPrefs(cur: PetPrefs, patch: unknown): PetPrefs {
  const p = patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
  const next: PetPrefs = { ...cur };
  if (typeof p.enabled === "boolean") next.enabled = p.enabled;
  if (typeof p.dnd === "boolean") next.dnd = p.dnd;
  if ("x" in p || "y" in p) {
    const x = coord(p.x);
    const y = coord(p.y);
    if (x !== null && y !== null) { next.x = x; next.y = y; }
    else if (p.x === null && p.y === null) { next.x = null; next.y = null; }
  }
  return next;
}

export function readPetPrefs(userData: string): PetPrefs {
  try {
    return parsePetPrefs(JSON.parse(readFileSync(join(userData, PET_FILE), "utf8")));
  } catch {
    return { ...PET_DEFAULTS };
  }
}

/** Written whole, through a temporary file, so a crash never leaves half a file. */
export function writePetPrefs(userData: string, prefs: PetPrefs): boolean {
  try {
    mkdirSync(userData, { recursive: true });
    const file = join(userData, PET_FILE);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(parsePetPrefs(prefs))}\n`, "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export interface PetRect { x: number; y: number; width: number; height: number }
export interface PetDisplay { workArea: PetRect }

/**
 * Where the window goes: the saved spot when its middle is still on a
 * display (moved back inside that display's work area), otherwise the
 * bottom right corner of the primary display's work area.
 */
export function petBounds(prefs: PetPrefs, displays: PetDisplay[], primary: PetDisplay): PetRect {
  const { width, height } = PET_SIZE;
  if (prefs.x !== null && prefs.y !== null) {
    const cx = prefs.x + width / 2;
    const cy = prefs.y + height / 2;
    const on = displays.find((d) => {
      const a = d.workArea;
      return cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height;
    });
    if (on) {
      const a = on.workArea;
      return {
        x: Math.min(Math.max(prefs.x, a.x), a.x + Math.max(0, a.width - width)),
        y: Math.min(Math.max(prefs.y, a.y), a.y + Math.max(0, a.height - height)),
        width,
        height,
      };
    }
  }
  const a = primary.workArea;
  return {
    x: a.x + Math.max(0, a.width - width - PET_MARGIN),
    y: a.y + Math.max(0, a.height - height - PET_MARGIN),
    width,
    height,
  };
}
