/* ATO-526: the words for a skill's external programs in Settings > Skills.
   `bins` comes from main (skill-bins.ts): {required, missing, installHint}.
   Shared by the renderer and Node checks (test/skill-bins.test.mjs); no DOM. */
function skillBinsNames(entries) {
  const names = (entries || []).map(e => String(e).split('|').join(' or '));
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
/* {tone: 'ok'|'miss', text, hint} or null when the skill names no programs. */
function skillBinsSummary(bins) {
  if (!bins || !Array.isArray(bins.required) || !bins.required.length) return null;
  const missing = Array.isArray(bins.missing) ? bins.missing : [];
  if (!missing.length) {
    return {tone: 'ok', text: skillBinsNames(bins.required) + ' found on this computer', hint: null};
  }
  const plural = missing.length > 1;
  return {
    tone: 'miss',
    text: 'Needs program' + (plural ? 's ' : ' ') + skillBinsNames(missing) + ', not found',
    hint: typeof bins.installHint === 'string' && bins.installHint.trim() ? bins.installHint.trim() : null,
  };
}
/* One line under the row's description. `esc` is the renderer's HTML escaper. */
function skillBinsRowHTML(bins, esc) {
  const s = skillBinsSummary(bins);
  if (!s) return '';
  return '<br><small class="set-skbins set-skbins--' + s.tone + '">' + esc(s.text)
    + (s.hint ? '. Install: <span class="mono">' + esc(s.hint) + '</span>' : '') + '</small>';
}
/* The detail page: the same words, the install line in full, and the way to re-check. */
function skillBinsDetailHTML(bins, esc) {
  const s = skillBinsSummary(bins);
  if (!s) return '';
  if (s.tone === 'ok') return '<p class="set-cap set-skbins set-skbins--ok">' + esc(s.text) + '</p>';
  return '<p class="set-cap set-skbins set-skbins--miss">' + esc(s.text) + '. '
    + (s.hint ? 'Install it with <span class="mono">' + esc(s.hint) + '</span>, then' : 'Install it, then')
    + ' press r to check again.</p>';
}
if (typeof module !== 'undefined') module.exports = {skillBinsNames, skillBinsSummary, skillBinsRowHTML, skillBinsDetailHTML};
