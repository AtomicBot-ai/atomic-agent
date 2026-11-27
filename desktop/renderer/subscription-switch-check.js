/* ---------------- ATO-2463: the live sign-in check on a switch ----------------
   ATO-1684 asks the Claude Code / Codex CLI itself whether it is signed in,
   but only in Add provider's subscription step. Picking a provider that is
   already saved, in the composer's model menu, used to show an expired login
   only on the first message. Now a switch to such a provider asks the same
   check (subscription-live-check.js, kept per app session by main) and, when
   the CLI says it is signed out, shows the same step: "Not signed in", the
   Sign in button and the exact command with Copy.

   Where the hint goes: the model menu still open with nothing else in it, the
   step opens there (as a provider with no key opens its key screen,
   bswOpenKey). The menu closed (a model row closes it at once), a toast with
   the command. Signed in, a failed check or a CLI the check did not find:
   nothing, the first answer says the rest (never block on an unknown).

   Signing in from that step ends on its main button or the sign-in poll's
   success, which come to wizSubscriptionStep: for this re-sign-in the saved
   entry stays as it is (no rewrite, no model step) and the step closes.

   Loaded after subscription-live-check.js and before renderer.js; it reads
   SEL, WIZ, OB, KIND_ROWS, selProviders, selActiveProviderId, toast and render
   only when a function runs, and renderer.js calls in through `typeof`
   guards. The pure part is exported for the unit suite. */

/** 'claude' or 'codex' for a saved subscription entry (`subscriptionCli` a name or {cli}), else null. Pure. */
function subSwitchCliOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sc = entry.subscriptionCli;
  const cli = typeof sc === 'string' ? sc : sc && typeof sc === 'object' ? sc.cli : null;
  return cli === 'claude' || cli === 'codex' ? cli : null;
}

/**
 * Where the signed-out hint goes, or null for none. Pure.
 * view: {stillActive, selectorOpen, setupOpen, firstRun}.
 */
function subSwitchWhere(check, view) {
  if (!check || check.state !== 'signed_out') return null;
  if (!view || view.stillActive === false || view.firstRun) return null;
  return view.selectorOpen && !view.setupOpen ? 'step' : 'toast';
}

/** The command the step shows for this CLI (wizSubscriptionLines' line). */
function subSwitchCommand(cli) { return cli === 'codex' ? 'codex login' : 'claude'; }

/** The toast's two lines when the menu is already closed. Pure. */
function subSwitchToastText(row, cli, win) {
  const service = (row && row.word) || (cli === 'codex' ? 'Codex' : 'Claude Code');
  const plan = (row && row.plan) || (cli === 'codex' ? 'ChatGPT' : 'Claude');
  return {
    title: service + ' is not signed in',
    sub: 'Run ' + subSwitchCommand(cli) + ' in ' + (win ? 'PowerShell' : 'Terminal') + ' and sign in with your ' + plan
      + ' account, or pick ' + service + ' in the model menu again to sign in from there.',
  };
}

/** The provider id the step was opened for, to re-sign in without rewriting the entry. */
let SUB_SWITCH_FOR = null;

/** Hook: a switch to provider `id` landed. Asks the live check when it is a subscription CLI. */
function subSwitchCheck(id) {
  if (!id || typeof subLiveAsk !== 'function' || typeof selProviders !== 'function') return;
  const entry = (selProviders() || []).find((p) => p && p.id === id);
  const cli = subSwitchCliOf(entry);
  if (!cli) return;
  // A signed-out answer kept from earlier is asked again once it is old: the person may have signed in since.
  const cur = SUB_LIVE.get(cli);
  const stale = !!(cur && !cur.checking && cur.check && cur.check.state === 'signed_out'
    && Date.now() - (cur.askedAt || 0) >= SUB_LIVE_RECHECK_MS);
  subLiveAsk(cli, stale);
  subLiveWhenDone(cli, (check) => subSwitchAnswered(id, cli, check));
}

function subSwitchAnswered(id, cli, check) {
  const where = subSwitchWhere(check, {
    stillActive: typeof selActiveProviderId === 'function' ? selActiveProviderId() === id : true,
    selectorOpen: typeof SEL !== 'undefined' && !!SEL.open,
    setupOpen: typeof WIZ !== 'undefined' && !!WIZ.phase,
    firstRun: typeof OB !== 'undefined' && !!OB.open,
  });
  if (!where) return;
  const row = typeof KIND_ROWS !== 'undefined' ? KIND_ROWS.find((k) => k.subscriptionCli === cli) : null;
  if (where === 'step' && row) {
    SEL.err = null;
    WIZ.row = row; WIZ.forId = id; WIZ.phase = 'configure'; WIZ.alone = false;
    WIZ.error = null; WIZ.softError = null; WIZ.errorDetail = null;
    WIZ.uncheckedFor = null; WIZ.acceptUnchecked = false; WIZ.modelChosen = false;
    SUB_SWITCH_FOR = id;
    render();
    return;
  }
  const t = subSwitchToastText(row, cli, /win/i.test((typeof navigator !== 'undefined' && navigator.platform) || ''));
  toast(t.title, t.sub, 'bad');
}

/**
 * Hook at the top of wizSubscriptionStep: the step opened by a switch ends
 * here once signed in. The saved entry is already active, so it is not
 * written again; the step closes back to the menu. False for any other step.
 */
function subSwitchSignedInDone(k) {
  const id = SUB_SWITCH_FOR;
  if (!id || !k || !k.subscriptionCli || WIZ.forId !== id) { SUB_SWITCH_FOR = null; return false; }
  SUB_SWITCH_FOR = null;
  WIZ.phase = null; WIZ.forId = null; WIZ.error = null;
  toast((k.word || 'The CLI') + ' is signed in', 'New messages run on your ' + (k.plan ? k.plan + ' ' : '') + 'plan.');
  render();
  return true;
}

if (typeof module !== 'undefined') {
  module.exports = {subSwitchCliOf, subSwitchWhere, subSwitchCommand, subSwitchToastText};
}
