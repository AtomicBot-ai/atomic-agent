/* ---------------- ATO-2745: where a saved key really went ----------------
   Loaded BEFORE telegram-token.js, discord-settings.js and renderer.js, so
   it only declares. Shared by the renderer and the Node checks
   (test/key-stored-note.test.mjs). No DOM, no IPC; the key itself never
   passes through here, only main's answer about where it landed.

   Settings › Telegram said "saved ... in a file only your user account can
   read" even with the agent's keys in the OS keychain (ATO-1639), and a key
   the keychain did not take stayed in the file without a word. Main's
   `app:dotenvSet` (agent-cli.ts desktopSecretSet) now answers `storedIn`
   ('keychain' | 'file') and `keychainFallback`, and `cli:upsertProvider`
   answers `keychainFallback`; these words say it the way 1Password and the
   macOS password prompts do: where, in one plain sentence. */

const KEY_WHERE_KEYCHAIN = 'in your system keychain';
const KEY_WHERE_FILE = 'in a private file only your user account can read';
const KEY_WHERE_FALLBACK = 'in a private file because the system keychain was not available';
const KEY_FALLBACK = 'Saved ' + KEY_WHERE_FALLBACK + '.';

/* Where a save's answer says the key went, as a phrase ("in your system
   keychain"), or '' when it does not say (an older main, a removal, a failure). */
function keyStoredWhere(res) {
  if (!res || res.ok === false) return '';
  if (res.keychainFallback === true) return KEY_WHERE_FALLBACK;
  if (res.storedIn === 'keychain') return KEY_WHERE_KEYCHAIN;
  if (res.storedIn === 'file') return KEY_WHERE_FILE;
  return '';
}

/* "Token saved." becomes "Token saved in your system keychain." (any
   "<Thing> saved." at the start), the rest of the line kept. */
function keySavedLine(line, res) {
  const where = keyStoredWhere(res);
  const text = String(line == null ? '' : line);
  return where ? text.replace(/^([A-Z][A-Za-z ]* saved)\./, '$1 ' + where + '.') : text;
}

/* `cli:upsertProvider`'s answer: a toast when the keychain is on but the
   provider key stayed in the settings file. `toastFn(title, line)`. Once in
   KEY_FALLBACK_QUIET_MS: the setup wizard saves the same entry on two passes. */
const KEY_FALLBACK_QUIET_MS = 15000;
let keyFallbackAt = -Infinity;
function keyFallbackToast(res, toastFn, now) {
  if (!res || res.ok === false || res.keychainFallback !== true || typeof toastFn !== 'function') return false;
  const t = typeof now === 'number' ? now : Date.now();
  if (t - keyFallbackAt < KEY_FALLBACK_QUIET_MS) return false;
  keyFallbackAt = t;
  toastFn('Key saved', KEY_FALLBACK);
  return true;
}

if (typeof module !== 'undefined') {
  module.exports = {KEY_WHERE_KEYCHAIN, KEY_WHERE_FILE, KEY_WHERE_FALLBACK, KEY_FALLBACK, KEY_FALLBACK_QUIET_MS, keyStoredWhere, keySavedLine, keyFallbackToast};
}
