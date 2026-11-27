/**
 * The keys block at the end of `/help` (ATO-2772). The hint strip under
 * the composer only has room for the keys of the moment, so a chord
 * like ctrl+p (next favorite model) was written down nowhere a person
 * would look. Precedent: Claude Code's `?` shortcuts list, Codex's
 * keyboard section in `/help`.
 *
 * Only global keys of the idle composer go here; panels state their own
 * keys in their footers. `keys-help.test.ts` checks the labels against
 * the constants the key handlers use.
 */
export const KEYS_HELP: readonly (readonly [key: string, what: string])[] = [
  ["esc", "open the menu (with a draft: clear it)"],
  ["ctrl+g", "menu shortcut: the next key picks an item"],
  ["tab", "move to the sidebar"],
  ["ctrl+r", "where the chat runs and on which model"],
  ["ctrl+p", "switch to the next favorite model (/model favorite)"],
  ["ctrl+t", "Enter steers or queues while a turn runs"],
  ["ctrl+n", "open a new terminal window here"],
  ["ctrl+c", "abort a turn; press twice to quit"],
];

export function formatKeysHelp(): string {
  const width = Math.max(...KEYS_HELP.map(([key]) => key.length));
  return [
    "keys:",
    ...KEYS_HELP.map(([key, what]) => `  ${key.padEnd(width)}  ${what}`),
  ].join("\n");
}
