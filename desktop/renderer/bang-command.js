/* ATO-1238 (epic: embedded terminal), item 3, first slice: `!command` typed
   in the composer goes to Terminal instead of to the model, the way Claude
   Code's `!` bash mode and Codex's `!` shell escape take it. Until the
   embedded terminal panel exists it opens Terminal.app in the chat's folder
   with the command typed into the input line but NOT run (ATO-1424,
   terminal:openWithCommand), so the person still presses Return themselves.

   Only where "Open in Terminal" on a code block is offered (macOS for now,
   ATO-1422) and only when the preload has the bridge; elsewhere `!ls` stays an
   ordinary message, as before.

   `!` alone, `!!` and `! ` with nothing after it are ordinary text. */

/** The command in composer text `text`, or null when it is not a `!command`. */
function bangCommandOf(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (s.length < 2 || s[0] !== '!' || s[1] === '!') return null;
  const cmd = s.slice(1).trim();
  return cmd ? cmd : null;
}

/** Whether `!command` goes to Terminal here: the same platforms and bridge as a code block's button. */
function bangTerminalOkFor(platform, bridge) {
  return platform === 'darwin' && !!(bridge && typeof bridge.terminalOpenWithCommand === 'function');
}
function bangTerminalOk() {
  return bangTerminalOkFor(typeof PLATFORM !== 'undefined' ? PLATFORM : null, typeof BR !== 'undefined' ? BR : null);
}

/** Opens Terminal with `cmd` typed. On failure the text goes back into an empty composer and a toast says why. */
function bangOpen(cmd, typed, cwd) {
  const fail = (why) => {
    const e = typeof document !== 'undefined' && document.getElementById('entry');
    if (e && !e.value) { e.value = typed; if (typeof S !== 'undefined') S.draft = typed; }
    if (typeof toast === 'function') toast("Couldn't open Terminal", typeof why === 'string' ? why : 'Your command is back in the box.', 'bad');
  };
  return Promise.resolve()
    .then(() => BR.terminalOpenWithCommand({ command: cmd, cwd: cwd || null }))
    .then((r) => { if (!r || r.ok !== true) fail(r && r.message); else if (typeof toast === 'function') toast('Opened in Terminal', 'Press Return there to run it.'); },
      () => fail());
}

if (typeof module !== 'undefined') {
  module.exports = {bangCommandOf, bangTerminalOkFor};
}
