/* ---------------- ATO-42: project instructions cut to fit ----------------
   Loaded before renderer.js; declares only. The agent (core #1467) caps a
   project's instructions at 1500 tokens in the local prompt and says so once
   per turn with an extensions frame:
     event: project_instructions  {name, tokens, truncated, max_tokens}
   When it cut them, the chat shows one line before the reply; uncut
   instructions need no line. An agent without the frame never sends it. */

/** The line for a `project_instructions` frame, '' when nothing was cut. */
function projectInstructionsLine(p) {
  if (!p || typeof p !== 'object' || p.truncated !== true) return '';
  const tokens = Number(p.tokens);
  const max = Number(p.max_tokens);
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'this project';
  const size = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) + ' tokens, ' : '';
  const cap = Number.isFinite(max) && max > 0 ? Math.round(max) : 1500;
  return 'Project instructions loaded: ' + name + ' (' + size + 'cut to ' + cap + ')';
}

/**
 * Puts that line into the chat log just before the turn's reply row
 * (`item`), as tool_disabled's line goes. `mkId` and `escape` are
 * renderer.js's nid and esc. True when a line was added.
 */
function projectInstructionsDraw(payload, log, item, mkId, escape) {
  const line = projectInstructionsLine(payload);
  if (!line || !Array.isArray(log) || !item) return false;
  const at = log.indexOf(item);
  if (at < 0) return false;
  log.splice(at, 0, {id: mkId(), k: 'system', note: true, text: escape(line)});
  return true;
}

if (typeof module !== 'undefined') module.exports = {projectInstructionsLine, projectInstructionsDraw};
