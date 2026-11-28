/**
 * ATO-2513: the routes of "Make your own pet" and of choosing a pet
 * (pet-skins.ts keeps the files). The main window makes and manages pets;
 * the pet page only reads the one that shows.
 *
 *   pet:skins       main window: {selected, skins: [{id, name, createdAt, preview}]}
 *   pet:saveSkin    main window: {name, frames: {idle, working, waiting, sleeping}} as
 *                   data URLs → the new pet, which then shows
 *   pet:useSkin     main window: a made pet's id, or "atom"
 *   pet:deleteSkin  main window: moves that pet's folder to the Trash
 *   pet:skinGet     pet page: the pictures of the pet that shows, or null (the atom)
 *   pet:skin        sent to the pet page whenever the pet that shows changes
 *   pet:openMaker   sent to the main window: open the dialog (View menu, the pet's menu)
 *
 * Making the pictures is Studio's (renderer/pet-maker.js calls BR.studio:
 * the price before Generate, local models free); nothing here spends money.
 */

import { randomBytes } from "node:crypto";
import { ipcMain, shell, type MenuItemConstructorOptions, type WebContents } from "electron";

import {
  PET_BUILT_IN,
  isPetSkinId,
  listPetSkins,
  petSkinDir,
  readPetSkinImages,
  readSelectedPetSkin,
  savePetSkin,
  writeSelectedPetSkin,
} from "./pet-skins.js";

export interface PetSkinsWiring {
  userData: string;
  isMain: (wc: WebContents) => boolean;
  isPet: (wc: WebContents) => boolean;
  /** Sends to the pet page, when it is up. */
  sendToPet: (channel: string, payload: unknown) => void;
  /** Shows the main window and asks it to open the dialog. */
  openMaker: () => void;
}

export interface PetSkins {
  /** The pet's right-click menu: Pet ▸ (the pets, Make Your Own Pet…). */
  menuItems(): MenuItemConstructorOptions[];
}

export function wirePetSkins(w: PetSkinsWiring): PetSkins {
  const current = () => {
    const id = readSelectedPetSkin(w.userData);
    return id === PET_BUILT_IN ? null : readPetSkinImages(w.userData, id);
  };
  const push = () => w.sendToPet("pet:skin", current());
  const use = (id: string): boolean => {
    if (id !== PET_BUILT_IN && !listPetSkins(w.userData).some((s) => s.id === id)) return false;
    if (!writeSelectedPetSkin(w.userData, id)) return false;
    push();
    return true;
  };

  ipcMain.handle("pet:skinGet", (event) => (w.isPet(event.sender) ? current() : null));

  ipcMain.handle("pet:skins", (event) => {
    if (!w.isMain(event.sender)) return null;
    return {
      selected: readSelectedPetSkin(w.userData),
      skins: listPetSkins(w.userData).map((s) => ({ ...s, preview: readPetSkinImages(w.userData, s.id)?.idle ?? null })),
    };
  });

  ipcMain.handle("pet:saveSkin", (event, raw: unknown) => {
    if (!w.isMain(event.sender)) return { ok: false, error: "The pet could not be saved." };
    const r = raw && typeof raw === "object" ? (raw as { name?: unknown; frames?: unknown }) : {};
    const saved = savePetSkin(w.userData, randomBytes(8).toString("hex"), r.name, r.frames, Date.now());
    if (!saved.ok) return saved;
    use(saved.skin.id);
    return { ok: true, skin: saved.skin };
  });

  ipcMain.handle("pet:useSkin", (event, id: unknown) => {
    if (!w.isMain(event.sender) || typeof id !== "string") return { ok: false };
    return { ok: use(id) };
  });

  ipcMain.handle("pet:deleteSkin", async (event, id: unknown) => {
    if (!w.isMain(event.sender) || !isPetSkinId(id)) return { ok: false, error: "That pet is not here any more." };
    const wasShown = readSelectedPetSkin(w.userData) === id;
    try {
      // The Trash, not a delete: a pet made with a paid model can come back.
      await shell.trashItem(petSkinDir(w.userData, id));
    } catch {
      return { ok: false, error: "The pet could not be moved to the Trash." };
    }
    if (wasShown) use(PET_BUILT_IN);
    return { ok: true };
  });

  return {
    menuItems() {
      const selected = readSelectedPetSkin(w.userData);
      const pets: MenuItemConstructorOptions[] = [
        { label: "Atom", type: "radio", checked: selected === PET_BUILT_IN, click: () => { use(PET_BUILT_IN); } },
        ...listPetSkins(w.userData).map((s): MenuItemConstructorOptions => ({
          label: s.name,
          type: "radio",
          checked: selected === s.id,
          click: () => { use(s.id); },
        })),
      ];
      return [{ label: "Pet", submenu: [...pets, { type: "separator" }, { label: "Make Your Own Pet…", click: w.openMaker }] }];
    },
  };
}
