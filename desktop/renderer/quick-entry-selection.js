/* ATO-985: the text selected in the app in front, in the quick-entry box
   (quick-entry.html). main reads it before the box opens
   (main/selected-text-ipc.ts); this file is the box's pure half, shared
   with the Node checks (test/quick-entry-selection.test.mjs): the actions
   that prefill the line, how the chip shows the text, and the message that
   goes to the new chat. As in Raycast's AI Commands: the words selected go
   with the request, quoted under it. */

/** The buttons under the chip, in order. `prompt` is what the line is set to. */
const QE_SELECTION_ACTIONS = [
  {id: 'rewrite', label: 'Rewrite', prompt: 'Rewrite this so it reads better:'},
  {id: 'translate', label: 'Translate', prompt: 'Translate this into English:'},
  {id: 'explain', label: 'Explain', prompt: 'Explain this:'},
  {id: 'summarize', label: 'Summarize', prompt: 'Summarize this:'},
];

/** The chip's one line: whitespace folded, at most `max` characters with an ellipsis. */
function qeSelectionPreview(selection, max) {
  const cap = max || 140;
  const line = String(selection || '').replace(/\s+/g, ' ').trim();
  return line.length > cap ? line.slice(0, cap - 1).trimEnd() + '…' : line;
}

/** The message sent: the request, then the selection as a Markdown quote. No selection: the request alone. */
function qeComposeWithSelection(prompt, selection) {
  const ask = String(prompt || '').trim();
  const sel = String(selection || '').replace(/\r\n/g, '\n').trim();
  if (!sel) return ask;
  const quoted = sel.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
  return ask ? ask + '\n\n' + quoted : quoted;
}

if (typeof module !== 'undefined') module.exports = {QE_SELECTION_ACTIONS, qeSelectionPreview, qeComposeWithSelection};
