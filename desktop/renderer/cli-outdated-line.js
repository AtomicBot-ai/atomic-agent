/* ---------------- ATO-2523: an outdated Claude Code / Codex CLI ----------------
   Loaded before renderer.js; declares only. The agent (core ATO-2523) reads
   the subscription CLI's version once per process and, when it is older than
   the oldest version it works with, says so once per session with an
   extensions frame:
     event: cli_outdated  {cli, version, minimum, update_commands, notice}
   The chat shows one line before the reply, with each update command drawn
   as code, as tool_disabled's line goes. The agent words it (`notice`); an
   agent that sends no `notice` is worded here from the fields. The commands
   are the agent's own for its platform (no Homebrew on Windows). An agent
   without the frame never sends it. */

/** Plain update commands from the frame, at most three, each a short single line. */
function cliOutdatedCommands(p) {
  const list = p && Array.isArray(p.update_commands) ? p.update_commands : [];
  return list.filter((c) => typeof c === 'string' && c.trim() && c.length <= 200 && !/[\r\n]/.test(c)).map((c) => c.trim()).slice(0, 3);
}

/** The plain line for a `cli_outdated` frame, '' when it names nothing. Commands are in backticks. */
function cliOutdatedLine(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.notice === 'string' && p.notice.trim()) return p.notice.trim();
  const name = p.cli === 'codex' ? 'Codex' : p.cli === 'claude' ? 'Claude Code' : '';
  if (!name) return '';
  const version = typeof p.version === 'string' && p.version ? ' ' + p.version : '';
  const cmds = cliOutdatedCommands(p).map((c) => '`' + c + '`').join(' or ');
  const min = typeof p.minimum === 'string' && p.minimum ? ' (Atomic Agent needs ' + p.minimum + ' or newer)' : '';
  return name + version + ' is out of date' + (cmds ? ': run ' + cmds : '') + min + '.';
}

/** The line as HTML: escaped, with each `command` drawn as code. `escape` is renderer.js's esc. */
function cliOutdatedHTML(line, escape) {
  return line.split('`').map((part, i) => (i % 2 === 1 && part ? '<code class="mono">' + escape(part) + '</code>' : escape(part))).join('');
}

/**
 * Puts that line into the chat log just before the turn's reply row
 * (`item`). `mkId` and `escape` are renderer.js's nid and esc. True when
 * a line was added.
 */
function cliOutdatedDraw(payload, log, item, mkId, escape) {
  const line = cliOutdatedLine(payload);
  if (!line || !Array.isArray(log) || !item) return false;
  const at = log.indexOf(item);
  if (at < 0) return false;
  log.splice(at, 0, {id: mkId(), k: 'system', note: true, text: cliOutdatedHTML(line, escape)});
  return true;
}

if (typeof module !== 'undefined') module.exports = {cliOutdatedCommands, cliOutdatedLine, cliOutdatedHTML, cliOutdatedDraw};
