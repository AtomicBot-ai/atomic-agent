/**
 * ATO-1072: the window's routes for saved recipes (rules in recipes-store.ts).
 *
 *   recipes:list    every saved recipe, newest first, each with its share link
 *   recipes:save    {id?, title, description, prompt, params} → create, or
 *                   replace a saved one's content; the checked recipe back
 *   recipes:delete  id → the list without it
 *
 * Main owns the file; the window only asks. A recipe holds text only, so
 * nothing here reaches the agent: running one is the window's New chat with
 * the text in the box.
 */

import { ipcMain } from "electron";

import { deleteRecipe, readRecipes, recipeForWindow, saveRecipe, updateRecipes, type Recipes } from "./recipes-store.js";

export interface RecipesIpcDeps {
  /** Where recipes.json lives (Electron's userData). */
  dir: () => string;
}

function listed(data: Recipes) {
  return data.recipes.map(recipeForWindow);
}

export function wireRecipesIpc(deps: RecipesIpcDeps): void {
  ipcMain.handle("recipes:list", () => ({ ok: true, recipes: listed(readRecipes(deps.dir())) }));
  ipcMain.handle("recipes:save", (_event, input: unknown) => {
    const res = updateRecipes(deps.dir(), (data) => saveRecipe(data, input));
    if (!res.ok) return res;
    return { ok: true, recipe: recipeForWindow(res.recipe), recipes: listed(res.data) };
  });
  ipcMain.handle("recipes:delete", (_event, id: unknown) => {
    const res = updateRecipes(deps.dir(), (data) => deleteRecipe(data, id));
    if (!res.ok) return res;
    return { ok: true, recipes: listed(res.data) };
  });
}
