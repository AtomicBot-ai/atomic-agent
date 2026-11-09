/* ---------------- ATO-965: /status, a snapshot of the running turn ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/status-snapshot.test.mjs).

   The same short card the terminal and Telegram print for /status
   (src/agent/status-snapshot.ts in the agent, which the desktop cannot
   import, so the wording is kept in step here):

     Plan: 5/8 · Now: integration tests
     Last result: tests passed
     Blocked: no · 2h 14m · 23 tool calls

   Built only from what the window already holds for the chat on screen:
   the tool cards of the turn in flight (since the last message that started
   a turn; a steer does not start one), the approval card waiting for an
   answer, and the moment the turn was sent. The desktop counts tool calls,
   not loop steps, and says so. Plan progress shows once the caller passes
   one ({done, total, current}, the agent's planProgress shape). */

/** `40s`, `5m 03s`, `2h 14m` (the agent's formatElapsed). */
function statusElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return total + 's';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return minutes + 'm ' + String(total % 60).padStart(2, '0') + 's';
  return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
}

function statusClip(text, max) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max - 1).join('') + '…';
}

/** The rows of the turn in flight: everything after the last user row that started one. */
function statusTurnRows(log) {
  if (!Array.isArray(log)) return [];
  let at = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i];
    if (m && m.k === 'user' && !m.steered) { at = i; break; }
  }
  return log.slice(at + 1);
}

/** A finished card in stable words: the tool's name and how it ended, never its output. */
function statusResultOf(card) {
  const name = String(card.name || 'tool');
  if (card.outcome === 'denied') return {text: name + ' · denied', ok: false};
  if (card.outcome === 'notrun') return {text: name + ' · not run', ok: false};
  return card.ok ? {text: name + ' · ok', ok: true} : {text: name + ' · failed', ok: false};
}

/** {running, planLine?, currentLine?, lastResultLine?, blockedLine?, elapsedMs, calls}
    opts: {running, startedAt, now, pending (the approval card waiting, or null), plan}. */
function statusSnapshotOf(log, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const running = !!o.running;
  const snap = {running, elapsedMs: 0, calls: 0};
  if (!running) return snap;
  const rows = statusTurnRows(log);
  const tools = rows.filter((m) => m && m.k === 'tool');
  snap.calls = tools.length;
  snap.elapsedMs = typeof o.startedAt === 'number' && o.startedAt > 0 ? Math.max(0, now - o.startedAt) : 0;
  const plan = o.plan;
  if (plan && plan.total > 0) {
    snap.planLine = 'Plan: ' + Math.min(Math.max(0, plan.done || 0), plan.total) + '/' + plan.total;
  }
  const blockedOn = o.pending ? String(o.pending.tool || 'an action') : null;
  const inFlight = tools.slice().reverse().find((m) => m.ok === null);
  const doing = blockedOn ? 'waiting for your approval of ' + blockedOn
    : plan && plan.current ? plan.current
    : inFlight ? 'Running ' + inFlight.name
    : 'thinking';
  snap.currentLine = 'Now: ' + statusClip(doing, 80);
  const done = tools.slice().reverse().find((m) => m.ok !== null);
  if (done) snap.lastResultLine = 'Last result: ' + statusClip(statusResultOf(done).text, 80);
  snap.blockedLine = blockedOn ? 'Blocked: yes, on your approval of ' + blockedOn : 'Blocked: no';
  return snap;
}

/** The card as plain lines. */
function statusSnapshotLines(snap) {
  if (!snap || !snap.running) return ['No turn is running.'];
  const calls = snap.calls + ' tool call' + (snap.calls === 1 ? '' : 's');
  const first = [snap.planLine, snap.currentLine].filter(Boolean).join(' · ');
  const lines = [first];
  if (snap.lastResultLine) lines.push(snap.lastResultLine);
  lines.push([snap.blockedLine || 'Blocked: no', statusElapsed(snap.elapsedMs), calls].join(' · '));
  return lines.filter((l) => l.length > 0);
}

/** For a system row, whose text is HTML: each line escaped, joined with <br>. */
function statusSnapshotHTML(snap, esc) {
  return statusSnapshotLines(snap).map((l) => esc(l)).join('<br>');
}

if (typeof module !== 'undefined') module.exports = {statusElapsed, statusTurnRows, statusResultOf, statusSnapshotOf, statusSnapshotLines, statusSnapshotHTML};
