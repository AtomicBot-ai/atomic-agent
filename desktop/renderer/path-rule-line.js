/* ---------------- ATO-2443: a path-scoped rule joined the prompt ----------------
   Loaded before renderer.js; declares only. A project rule scoped to some
   files (`.atomic-agent/rules/*.md` with `paths:`, a Cursor rule with
   `globs:`, or the person's own `~/.atomic-agent/rules`) joins the prompt
   once the agent reads or changes a matching file. The agent (core #2054)
   says so once per rule per chat with an extensions frame:
     event: path_rule_attached  {path, patterns, step_index}
   The chat shows one line for it, before the turn's reply, like the
   terminal's "rule attached: <file>". An agent without the frame never
   sends it, so older agents show nothing. */

/** The line for a `path_rule_attached` frame, '' when it names no rule file. */
function pathRuleLine(p) {
  if (!p || typeof p !== 'object' || typeof p.path !== 'string') return '';
  const path = p.path.trim();
  if (!path) return '';
  return 'Rule attached: ' + path;
}

/**
 * Puts that line into the chat log just before the turn's reply row
 * (`item`), as tool_disabled's line goes. `mkId` and `escape` are
 * renderer.js's nid and esc. True when a line was added.
 */
function pathRuleDraw(payload, log, item, mkId, escape) {
  const line = pathRuleLine(payload);
  if (!line || !Array.isArray(log) || !item) return false;
  const at = log.indexOf(item);
  if (at < 0) return false;
  log.splice(at, 0, {id: mkId(), k: 'system', note: true, text: escape(line)});
  return true;
}

if (typeof module !== 'undefined') module.exports = {pathRuleLine, pathRuleDraw};
