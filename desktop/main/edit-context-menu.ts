import { Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";

/**
 * ATO-668: the ordinary right-click menu on text.
 *
 * A right-click in the composer, in a settings field or on selected text in
 * a reply used to do nothing at all: Chromium shows no menu of its own in
 * Electron. Now it opens Cut, Copy, Paste and Select All (only what applies),
 * with spelling suggestions and Add to Dictionary on a misspelled word.
 *
 * The page's own menus stay theirs. A chat row, a file chip and the mic
 * button call `preventDefault()` on `contextmenu` (renderer.js), and
 * Chromium never raises `context-menu` in main for an event the page
 * cancelled, so this menu never stands in front of them.
 *
 * The template is pure (no Electron calls) so the unit test can drive it;
 * only `wireEditContextMenu` touches a window.
 */

/** How many spelling suggestions the menu lists at most. */
export const MAX_SUGGESTIONS = 5;

/** The fields of Electron's ContextMenuParams the menu reads. */
export type EditMenuParams = Pick<
  ContextMenuParams,
  "isEditable" | "selectionText" | "misspelledWord" | "dictionarySuggestions" | "editFlags"
>;

/** What a spelling item does when clicked; main.ts wires these to the window's webContents and session. */
export interface EditMenuActions {
  replaceMisspelling: (word: string) => void;
  addToDictionary: (word: string) => void;
}

/**
 * Spellcheck is on where it costs nothing: macOS and Windows check with the
 * system's own spellchecker. On Linux Chromium would download Hunspell
 * dictionaries from Google's servers on first use, so it stays off there.
 */
export function spellcheckEnabled(platform: NodeJS.Platform): boolean {
  return platform !== "linux";
}

/** The menu for one right-click, or an empty list when there is nothing to offer (no menu then). */
export function editContextMenuTemplate(params: EditMenuParams, actions: EditMenuActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const word = params.misspelledWord;
  if (params.isEditable && word) {
    const suggestions = (params.dictionarySuggestions || []).slice(0, MAX_SUGGESTIONS);
    if (suggestions.length === 0) items.push({ label: "No Guesses Found", enabled: false });
    for (const s of suggestions) items.push({ label: s, click: () => actions.replaceMisspelling(s) });
    items.push({ type: "separator" });
    items.push({ label: "Add to Dictionary", click: () => actions.addToDictionary(word) });
    items.push({ type: "separator" });
  }
  const f = params.editFlags;
  if (params.isEditable) {
    items.push(
      { role: "cut", enabled: f.canCut },
      { role: "copy", enabled: f.canCopy },
      { role: "paste", enabled: f.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: f.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy", enabled: f.canCopy });
  }
  return items;
}

/** Opens the menu on every right-click the page did not handle itself. */
export function wireEditContextMenu(contents: WebContents): void {
  contents.on("context-menu", (_event, params) => {
    const template = editContextMenuTemplate(params, {
      replaceMisspelling: (w) => contents.replaceMisspelling(w),
      addToDictionary: (w) => { contents.session.addWordToSpellCheckerDictionary(w); },
    });
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup();
  });
}
