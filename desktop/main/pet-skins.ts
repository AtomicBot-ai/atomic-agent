/**
 * ATO-2513: pets a person made ("Make your own pet", renderer/pet-maker.js)
 * and which one shows. Plain files in userData, like pet.json: about this
 * app on this computer, never the agent's config.
 *
 *   <userData>/pets/<id>/pet.json      {name, createdAt, frames: {idle: "idle.png", ...}}
 *   <userData>/pets/<id>/<frame>.<ext>  one picture per frame
 *   <userData>/pets/selected.json      {id}: a made pet's id, or "atom" (the built-in one)
 *
 * The pictures come from Studio's image generation (the same Core jobs the
 * agent's image.generate runs) and reach main as data URLs the window read
 * with Studio's own preview route, so main never opens a path the window
 * names. Each is checked to be a PNG, JPEG or WebP by its first bytes and
 * kept under PET_FRAME_MAX_BYTES. No Electron import: the node tests load it.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PetState } from "./pet-state.js";

/** The pictures a made pet has; the seven states share them (petSkinFrame). */
export const PET_SKIN_FRAMES = ["idle", "working", "waiting", "sleeping"] as const;
export type PetSkinFrame = (typeof PET_SKIN_FRAMES)[number];

export const PET_BUILT_IN = "atom";
export const PET_SKINS_DIR = "pets";
export const PET_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const PET_NAME_MAX = 40;
/** At most this many made pets; the oldest has to be deleted before a new one. */
export const PET_SKINS_MAX = 24;

const ID_RE = /^[a-f0-9]{16}$/;
const MIME_EXT: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function petSkinFrame(state: PetState): PetSkinFrame {
  if (state === "working" || state === "thinking") return "working";
  if (state === "waiting" || state === "error") return "waiting";
  if (state === "sleeping") return "sleeping";
  return "idle";
}

export function isPetSkinId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

/** A name to keep: one line, trimmed, clipped; "My pet" when empty. */
export function petSkinName(raw: unknown): string {
  const flat = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return (flat || "My pet").slice(0, PET_NAME_MAX);
}

/** A data URL of a picture, checked by its first bytes; null for anything else. */
export function petImageFromDataUrl(raw: unknown): { mime: string; ext: string; bytes: Buffer } | null {
  if (typeof raw !== "string") return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(raw);
  if (!m) return null;
  const mime = m[1] as string;
  // Base64 is 4/3 of the bytes: refuse a huge string before decoding it.
  if ((m[2] as string).length > Math.ceil(PET_FRAME_MAX_BYTES * 1.4)) return null;
  const bytes = Buffer.from(m[2] as string, "base64");
  if (bytes.length === 0 || bytes.length > PET_FRAME_MAX_BYTES) return null;
  const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  const kind = png ? "image/png" : jpeg ? "image/jpeg" : webp ? "image/webp" : null;
  if (!kind || kind !== mime) return null;
  return { mime, ext: MIME_EXT[mime] as string, bytes };
}

export interface PetSkinInfo {
  id: string;
  name: string;
  createdAt: number;
}

interface PetSkinFile extends PetSkinInfo {
  frames: Record<PetSkinFrame, string>;
}

const skinsRoot = (userData: string) => join(userData, PET_SKINS_DIR);
export const petSkinDir = (userData: string, id: string) => join(skinsRoot(userData), id);

function readSkinFile(userData: string, id: string): PetSkinFile | null {
  if (!isPetSkinId(id)) return null;
  try {
    const o = JSON.parse(readFileSync(join(petSkinDir(userData, id), "pet.json"), "utf8")) as Record<string, unknown>;
    const frames = o.frames && typeof o.frames === "object" ? (o.frames as Record<string, unknown>) : {};
    const out = {} as Record<PetSkinFrame, string>;
    for (const f of PET_SKIN_FRAMES) {
      const file = frames[f];
      // A file name of its own folder only: `idle.png`, never a path.
      if (typeof file !== "string" || !new RegExp(`^${f}\\.(png|jpg|webp)$`).test(file)) return null;
      out[f] = file;
    }
    return { id, name: petSkinName(o.name), createdAt: typeof o.createdAt === "number" ? o.createdAt : 0, frames: out };
  } catch {
    return null;
  }
}

/** The made pets, newest first; a broken folder is left out. */
export function listPetSkins(userData: string): PetSkinInfo[] {
  let names: string[] = [];
  try {
    names = readdirSync(skinsRoot(userData));
  } catch {
    return [];
  }
  return names
    .map((id) => readSkinFile(userData, id))
    .filter((s): s is PetSkinFile => s !== null)
    .map(({ id, name, createdAt }) => ({ id, name, createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function writeAtomically(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export type PetSkinSave = { ok: true; skin: PetSkinInfo } | { ok: false; error: string };

/** Keep a made pet: every frame must be a picture. `id` is the caller's fresh random id. */
export function savePetSkin(userData: string, id: string, name: unknown, frames: unknown, now: number): PetSkinSave {
  if (!isPetSkinId(id)) return { ok: false, error: "The pet could not be saved." };
  if (listPetSkins(userData).length >= PET_SKINS_MAX) {
    return { ok: false, error: `You have ${PET_SKINS_MAX} pets already. Delete one to make room.` };
  }
  const given = frames && typeof frames === "object" ? (frames as Record<string, unknown>) : {};
  const images: Array<[PetSkinFrame, { ext: string; bytes: Buffer }]> = [];
  for (const f of PET_SKIN_FRAMES) {
    const img = petImageFromDataUrl(given[f]);
    if (!img) return { ok: false, error: "One of the pictures could not be read. Try making the pet again." };
    images.push([f, img]);
  }
  try {
    const dir = petSkinDir(userData, id);
    mkdirSync(dir, { recursive: true });
    const files = {} as Record<PetSkinFrame, string>;
    for (const [f, img] of images) {
      files[f] = `${f}.${img.ext}`;
      writeAtomically(join(dir, files[f]), img.bytes);
    }
    const skin: PetSkinInfo = { id, name: petSkinName(name), createdAt: now };
    writeAtomically(join(dir, "pet.json"), `${JSON.stringify({ ...skin, frames: files })}\n`);
    return { ok: true, skin };
  } catch {
    return { ok: false, error: "The pet could not be saved on this computer. Check that the disk has room." };
  }
}

/** A made pet's pictures as data URLs, for the pet page (its CSP takes only `data:` images). */
export function readPetSkinImages(userData: string, id: string): Record<PetSkinFrame, string> | null {
  const skin = readSkinFile(userData, id);
  if (!skin) return null;
  try {
    const out = {} as Record<PetSkinFrame, string>;
    for (const f of PET_SKIN_FRAMES) {
      const file = skin.frames[f];
      const ext = file.slice(file.lastIndexOf(".") + 1);
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      out[f] = `data:${mime};base64,${readFileSync(join(petSkinDir(userData, id), file)).toString("base64")}`;
    }
    return out;
  } catch {
    return null;
  }
}

/** The pet that shows: a made pet that still exists, else the built-in one. */
export function readSelectedPetSkin(userData: string): string {
  try {
    const o = JSON.parse(readFileSync(join(skinsRoot(userData), "selected.json"), "utf8")) as { id?: unknown };
    if (isPetSkinId(o.id) && readSkinFile(userData, o.id)) return o.id;
  } catch { /* none chosen yet */ }
  return PET_BUILT_IN;
}

export function writeSelectedPetSkin(userData: string, id: string): boolean {
  if (id !== PET_BUILT_IN && !isPetSkinId(id)) return false;
  try {
    mkdirSync(skinsRoot(userData), { recursive: true });
    writeAtomically(join(skinsRoot(userData), "selected.json"), `${JSON.stringify({ id })}\n`);
    return true;
  } catch {
    return false;
  }
}
