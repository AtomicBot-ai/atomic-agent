/**
 * ATO-2500: the model picker's favourites, kept in the file the terminal
 * uses (model-favorites-store.ts).
 *
 *   modelFav:load    (legacy?: string[]) → {ok, keys, saved}. The file's list.
 *                    `legacy` is the window's old localStorage list
 *                    (ATO-2169): merged in once and written; `saved` false
 *                    means the merge could not be written, so the window
 *                    draws the merged list and keeps its old one for the
 *                    next try.
 *   modelFav:set     (key, on) → {ok, keys, on}. Reads the file again, sets
 *                    `key` starred (`on` true) or not, writes it. The window
 *                    sends the state it drew, not a flip, so a change the
 *                    terminal made meanwhile is kept. {ok:false, keys} when
 *                    the key is not one, `on` is not a boolean or the file
 *                    could not be written (`keys` is then the list as it
 *                    stands).
 */

import { ipcMain } from "electron";

import { modelFavLoad, modelFavSet } from "./model-favorites-store.js";

export interface ModelFavoritesIpcDeps {
  /** The agent's state dir (`~/.atomic-agent` on a default install), shared with the terminal. */
  stateDir: string;
}

export function wireModelFavoritesIpc(deps: ModelFavoritesIpcDeps): void {
  ipcMain.handle("modelFav:load", (_event, legacy: unknown) => modelFavLoad(deps.stateDir, legacy));
  ipcMain.handle("modelFav:set", (_event, key: unknown, on: unknown) => modelFavSet(deps.stateDir, key, on));
}
