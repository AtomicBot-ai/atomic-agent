/**
 * ATO-2740: the options of the native dialog behind `importFacts:pick`.
 *
 * The agent reads either the data export `.zip` or the folder it was
 * unpacked to (import-facts-input.ts checks the path either way), and its
 * error words say so. On macOS one dialog takes both. On Windows and Linux
 * Electron's showOpenDialog cannot offer `openFile` and `openDirectory` at
 * once (with both set it shows a folder picker only; Electron docs,
 * dialog.showOpenDialog), so the window offers two buttons, "Choose ZIP
 * file" and "Choose folder", and sends which one as `kind`.
 *
 * Pure: the platform is passed in so the unit test can check every OS.
 */

export type FactsPickKind = "file" | "folder";
type DialogProperty = "openFile" | "openDirectory";

export interface FactsPickOptions {
  title: string;
  properties: DialogProperty[];
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** Only these two words come from the window; anything else means "the default for this OS". */
export function factsPickKind(raw: unknown): FactsPickKind | null {
  return raw === "file" || raw === "folder" ? raw : null;
}

export function factsPickDialogOptions(source: unknown, rawKind: unknown, platform: NodeJS.Platform = process.platform): FactsPickOptions {
  const name = source === "chatgpt" ? "ChatGPT" : "Claude";
  const kind = factsPickKind(rawKind);
  const filters = [{ name: name + " data export", extensions: ["zip"] }];
  if (platform === "darwin" && !kind) {
    return { title: "Choose the .zip from " + name + "'s Export data, or the folder it was unpacked to", properties: ["openFile", "openDirectory"], filters };
  }
  if (kind === "folder") {
    return { title: "Choose the folder your " + name + " export was unpacked to", properties: ["openDirectory"] };
  }
  return { title: "Choose the .zip from " + name + "'s Export data", properties: ["openFile"], filters };
}
