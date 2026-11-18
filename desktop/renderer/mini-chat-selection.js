/* ATO-985: the text selected in the app in front, in the mini chat window
   (mini-chat.html). The hotkey reads it before the window opens
   (main/selected-text-ipc.ts); this file is the page's pure half, shared
   with the Node checks (test/mini-chat-selection.test.mjs): the actions
   that prefill the message, the languages Translate offers, how the chip
   shows the text, and the message that goes to the chat. As in Raycast's
   AI Commands: the words selected go with the request, quoted under it. */

/** The buttons under the chip, in order. `prompt` is what the message is set to; Translate's names the language. */
const MC_SELECTION_ACTIONS = [
  {id: 'rewrite', label: 'Rewrite', prompt: 'Rewrite this so it reads better:'},
  {id: 'translate', label: 'Translate', prompt: 'Translate this into {lang}:'},
  {id: 'explain', label: 'Explain', prompt: 'Explain this:'},
  {id: 'summarize', label: 'Summarize', prompt: 'Summarize this:'},
];

/** The languages Translate's picker always lists, in order. */
const MC_TRANSLATE_LANGUAGES = ['English', 'Russian', 'Spanish', 'German', 'French', 'Chinese', 'Japanese', 'Portuguese'];

/**
 * The system language's English name ("ru-RU" gives "Russian"), from its
 * base code; null when it cannot be named. `displayNames` is an
 * Intl.DisplayNames for English, passed in so the checks can stub it.
 */
function mcLanguageName(code, displayNames) {
  const base = String(code || '').trim().split(/[-_]/)[0].toLowerCase();
  if (!/^[a-z]{2,3}$/.test(base) || !displayNames) return null;
  let name = null;
  try { name = displayNames.of(base); } catch (e) { return null; }
  if (typeof name !== 'string' || !name || name.toLowerCase() === base) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The picker's list: the system language first, then the common ones, each
 * once. A language used last that is in neither (picked under another
 * system language) comes right after the system one, so it stays pickable.
 */
function mcLanguageOptions(systemName, saved) {
  const out = [];
  const add = (l) => {
    if (typeof l !== 'string' || !l.trim()) return;
    const name = l.trim();
    if (!out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
  };
  add(systemName);
  const known = (l) => typeof l === 'string' && MC_TRANSLATE_LANGUAGES.some((o) => o.toLowerCase() === l.trim().toLowerCase());
  if (!known(saved)) add(saved);
  MC_TRANSLATE_LANGUAGES.forEach(add);
  return out;
}

/** The language the picker starts on: the one used last, else the first in the list (the system language). */
function mcDefaultLanguage(saved, options) {
  const list = Array.isArray(options) && options.length ? options : MC_TRANSLATE_LANGUAGES;
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  return list[0];
}

/** What an action puts in the message box. Translate needs its language. */
function mcSelectionPrompt(action, lang) {
  if (!action) return '';
  return String(action.prompt).replace('{lang}', lang || 'English');
}

/** The chip's one line: whitespace folded, at most `max` characters with an ellipsis. */
function mcSelectionPreview(selection, max) {
  const cap = max || 140;
  const line = String(selection || '').replace(/\s+/g, ' ').trim();
  return line.length > cap ? line.slice(0, cap - 1).trimEnd() + '…' : line;
}

/** The message sent: the request, then the selection as a Markdown quote. No selection: the request alone. */
function mcComposeWithSelection(prompt, selection) {
  const ask = String(prompt || '').trim();
  const sel = String(selection || '').replace(/\r\n/g, '\n').trim();
  if (!sel) return ask;
  const quoted = sel.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
  return ask ? ask + '\n\n' + quoted : quoted;
}

if (typeof module !== 'undefined') {
  module.exports = {MC_SELECTION_ACTIONS, MC_TRANSLATE_LANGUAGES, mcLanguageName, mcLanguageOptions, mcDefaultLanguage,
    mcSelectionPrompt, mcSelectionPreview, mcComposeWithSelection};
}
