/* ATO-2505 / ATO-2528 / ATO-2529: the security lines of the approval card
   and of a finished turn.

   An `approval_request` frame from agent 0.10.1 on can carry:
   - `egress`: where the call sends data ({kind, host, direction, label,
     unapproved?}). The card says "Sends data to -> x.io, github.com".
     Only outbound destinations count; one no one approved yet (no host,
     or `unapproved`, the egress hold) comes first and is always named,
     known ones fold into "+N more" past four. The same words and order as
     the TUI, Telegram and Discord (src/approval/egress-scan.ts
     formatEgressLine).
   - `securityFinding` ({rule, reason, confidence}) and `askEveryLevel`:
     an argument check caught a credential read, an encoded script, a
     change to a startup or SSH file, or a secret in a request. The card
     says "Security check: reads a credential file (~/.ssh/id_rsa), 90%
     sure; asks in every mode" (src/approval/security-finding-line.ts).
   A stored call's `approvals` can carry `finding` on an answer and
   `guard` ({decision, reason}) on a refusal by the person's security
   rules (guard.md). The turn summary lists them under "Security".

   An older agent sends none of these, and nothing is drawn.
   Loaded before renderer.js; declares only. Returns plain text, or html
   built with the caller's esc. Shared by the renderer and the Node checks
   (test/approval-security.test.mjs). */

const APPR_EGRESS_MAX = 4;
const APPR_SEC_MAX = 160;
/* The replies whose "Security" list under the summary line is open. */
const TURN_SEC_OPEN = new Set();

/** One line of plain text: control and invisible characters become a space (egress-scan.ts cleanEgressLabel). */
function apprSecClean(raw) {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > APPR_SEC_MAX ? flat.slice(0, APPR_SEC_MAX - 1).trimEnd() + '…' : flat;
}

function apprEgressOne(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.direction !== 'outbound' && d.direction !== 'inbound') return null;
  const host = typeof d.host === 'string' && d.host ? d.host : null;
  const label = apprSecClean(typeof d.label === 'string' && d.label ? d.label : host || '');
  if (!label) return null;
  const out = {kind: typeof d.kind === 'string' ? d.kind : '', host, direction: d.direction, label};
  if (d.unapproved === true) out.unapproved = true;
  return out;
}

function apprFindingOne(f) {
  if (!f || typeof f !== 'object' || typeof f.reason !== 'string' || !f.reason.trim()) return null;
  const c = Number(f.confidence);
  return {rule: typeof f.rule === 'string' ? f.rule : '', reason: f.reason, confidence: Number.isFinite(c) ? Math.min(Math.max(c, 0), 1) : 1};
}

/** The security fields of an `approval_request` frame, kept on the card's row. */
function apprSecurityFields(payload) {
  const p = payload || {};
  const out = {};
  if (Array.isArray(p.egress)) {
    const egress = p.egress.map(apprEgressOne).filter(Boolean);
    if (egress.length) out.egress = egress;
  }
  const finding = apprFindingOne(p.securityFinding);
  if (finding) out.securityFinding = finding;
  if (p.askEveryLevel === true) out.askEveryLevel = true;
  return out;
}

/** "Sends data to -> x.io, github.com (+2 more)", or '' when nothing goes out. Plain text. */
function apprEgressLine(m) {
  const list = Array.isArray(m && m.egress) ? m.egress.filter((d) => d && d.direction === 'outbound') : [];
  const unknownOf = (d) => !d.host || d.unapproved === true;
  const uniq = (xs) => [...new Set(xs)];
  const unknown = uniq(list.filter(unknownOf).map((d) => apprSecClean(d.label)).filter(Boolean));
  const known = uniq(list.filter((d) => !unknownOf(d)).map((d) => apprSecClean(d.label)).filter(Boolean))
    .filter((l) => !unknown.includes(l));
  if (!unknown.length && !known.length) return '';
  const room = Math.max(APPR_EGRESS_MAX - unknown.length, 0);
  const more = known.length - room;
  return 'Sends data to -> ' + unknown.concat(known.slice(0, room)).join(', ') + (more > 0 ? ' (+' + more + ' more)' : '');
}

/** Whether the card's egress line names a host no one approved yet (drawn as a warning). */
function apprEgressUnknown(m) {
  return Array.isArray(m && m.egress) && m.egress.some((d) => d && d.direction === 'outbound' && (!d.host || d.unapproved === true));
}

/** "Security check: reads a credential file (~/.ssh/id_rsa), 90% sure; asks in every mode", or ''. Plain text. */
function apprFindingLine(m) {
  const f = apprFindingOne(m && m.securityFinding);
  if (!f) return '';
  const reason = apprSecClean(f.reason);
  if (!reason) return '';
  return 'Security check: ' + reason + ', ' + Math.round(f.confidence * 100) + '% sure'
    + (m.askEveryLevel === true ? '; asks in every mode' : '');
}

/** The security records of one stored call: what an argument check caught
    (and the answer), and what the security rules refused. */
function securityRecordsOf(approvals) {
  if (!Array.isArray(approvals)) return [];
  const out = [];
  for (const a of approvals) {
    if (!a || typeof a !== 'object') continue;
    const at = Number.isFinite(a.at) ? a.at : null;
    const category = typeof a.category === 'string' ? a.category : '';
    if (a.guard && typeof a.guard === 'object') {
      out.push({kind: 'guard', decision: a.guard.decision === 'no-answer' ? 'no-answer' : 'block',
        reason: typeof a.guard.reason === 'string' ? a.guard.reason : '', category, at});
      continue;
    }
    const f = apprFindingOne(a.finding);
    if (f && (a.verdict === 'approved' || a.verdict === 'denied')) {
      out.push({kind: 'finding', verdict: a.verdict, rule: f.rule, reason: f.reason, confidence: f.confidence, category, at});
    }
  }
  return out;
}

/** A guard refusal is the rules' answer, not the person's: no "Denied by you" receipt. */
function apprIsPersonAnswer(a) {
  return !!a && (a.verdict === 'approved' || a.verdict === 'denied') && !(a.guard && typeof a.guard === 'object');
}

/** One record in words (plain text). */
function securityRecordText(r) {
  if (r.kind === 'guard') {
    return r.decision === 'no-answer'
      ? 'Blocked by your security rules: the rules reviewer gave no answer'
      : 'Blocked by your security rules' + (apprSecClean(r.reason) ? ': ' + apprSecClean(r.reason) : '');
  }
  return 'Security check: ' + apprSecClean(r.reason) + ', ' + Math.round(r.confidence * 100) + '% sure · '
    + (r.verdict === 'approved' ? 'you allowed it' : 'you denied it');
}

/** "Security: 2 checks" under the summary line, and when opened the list.
    f.security: [{row, ...record}] (turn-summary.js turnFoldsOf).
    Nothing when the turn had none. deps: {esc, ic, autoWhat?}. */
function turnSecurityHTML(f, deps) {
  const {esc, ic} = deps;
  const list = Array.isArray(f && f.security) ? f.security : [];
  if (!list.length) return '';
  const blocked = list.filter((r) => r.kind === 'guard').length;
  const open = TURN_SEC_OPEN.has(f.replyId);
  const what = (r) => deps.autoWhat && r.row ? deps.autoWhat(r.row) : esc((r.row && r.row.name) || 'a tool call');
  const label = 'Security: ' + list.length + (list.length === 1 ? ' check' : ' checks')
    + (blocked ? ', ' + blocked + ' blocked by your rules' : '');
  return '<div class="ts-auto ts-sec">'
    + '<button class="turnsum" data-tssec="' + esc(f.replyId) + '" aria-expanded="' + open + '"'
      + ' title="' + (open ? 'Hide the security checks' : 'Show the security checks') + '">'
      + ic(open ? 'chevD' : 'chevR')
      + '<span class="ts-l' + (blocked ? ' ts-bad' : '') + '">' + esc(label) + '</span>'
    + '</button>'
    + (open ? '<div class="discbody ts-autolist">' + list.map((r) => '<div class="ts-autorow">' + what(r)
        + ' · <span class="ts-autowhy">' + esc(securityRecordText(r)) + '</span></div>').join('') + '</div>' : '')
    + '</div>';
}

if (typeof module !== 'undefined') module.exports = {APPR_EGRESS_MAX, TURN_SEC_OPEN, apprSecClean, apprSecurityFields, apprEgressLine, apprEgressUnknown, apprFindingLine, securityRecordsOf, apprIsPersonAnswer, securityRecordText, turnSecurityHTML};
