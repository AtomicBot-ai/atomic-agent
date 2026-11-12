/* ATO-1268: smart approval's verdict on the approval card.
   When the agent's risk review rated a request medium or high (or gave no
   answer), its `approval_request` frame carries `riskNote`, `riskLevel` and,
   from this version, `riskReason`. The card says it in one line:
   "Risk check: medium. Installs a package". The same words as the TUI,
   Telegram and Discord (src/approval/risk-review.ts formatRiskLine).
   An older agent sends no `riskReason`: the reason is read out of `riskNote`
   ("risk check: medium (installs a package)"). An agent without smart
   approval sends none of them, and the card has no line.
   Loaded before renderer.js; declares only. Returns plain text: the card
   escapes it (esc) like every other string from the agent.
   Shared by the renderer and the Node checks (test/approval-risk.test.mjs). */

const APPR_RISK_LEVELS = ['low', 'medium', 'high'];
const APPR_RISK_MAX = 160;

/** One line, no control characters, bounded (risk-review.ts sanitizeRiskReason). */
function apprRiskClean(raw) {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > APPR_RISK_MAX ? flat.slice(0, APPR_RISK_MAX - 1).trimEnd() + '…' : flat;
}

/** The risk fields of an `approval_request` frame, kept on the card's row. */
function apprRiskFields(payload) {
  const p = payload || {};
  const out = {};
  if (typeof p.riskNote === 'string' && p.riskNote.trim()) out.riskNote = p.riskNote;
  if (APPR_RISK_LEVELS.includes(p.riskLevel)) out.riskLevel = p.riskLevel;
  if (typeof p.riskReason === 'string' && p.riskReason.trim()) out.riskReason = p.riskReason;
  return out;
}

/** "Risk check: medium. Installs a package", or '' when no review ran. Plain text. */
function apprRiskLine(m) {
  const r = m || {};
  const note = typeof r.riskNote === 'string' ? r.riskNote.trim() : '';
  if (APPR_RISK_LEVELS.includes(r.riskLevel)) {
    let reason = typeof r.riskReason === 'string' ? r.riskReason : '';
    if (!reason) {
      const parsed = /^risk check: [a-z]+ \((.*)\)$/i.exec(note);
      if (parsed) reason = parsed[1] || '';
    }
    reason = apprRiskClean(reason);
    return reason
      ? 'Risk check: ' + r.riskLevel + '. ' + reason.charAt(0).toUpperCase() + reason.slice(1)
      : 'Risk check: ' + r.riskLevel + '.';
  }
  if (!note) return '';
  const body = apprRiskClean(note.replace(/^risk check:\s*/i, ''));
  if (!body) return '';
  return 'Risk check: ' + body + (/[.!?…]$/.test(body) ? '' : '.');
}

if (typeof module !== 'undefined') module.exports = {apprRiskFields, apprRiskLine, apprRiskClean};
