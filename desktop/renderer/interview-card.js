/* ---------------- ATO-1467: the "Talk to the team" interview invite ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/interview-invite.test.mjs).

   Whether the invite may show at all (analytics, the PostHog flag, 7 days,
   90 days, 2 times, "Don't ask again") is main's call
   (main/interview-invite.ts). This is the window's half: what it knows by
   itself (a turn running, first-run setup, an error on screen) and the
   card's markup. */

/* The window's own reasons to keep the card away right now. `live` is
   S.live, `busy` S.busy || S.pending, `onboarding` OB.open, `dlError` a
   setup download that failed. */
function interviewWindowState(input) {
  const i = input || {};
  const live = i.live || {};
  return {
    busy: !!i.busy,
    onboarding: !!i.onboarding,
    error: live.state === 'error' || !!live.error || !!i.dlError,
  };
}

/* True when the window may ask main about the invite: the agent is up and
   nothing above is in the way. */
function interviewMayAsk(input) {
  const i = input || {};
  const w = interviewWindowState(i);
  return !!i.live && i.live.state === 'connected' && !w.busy && !w.onboarding && !w.error;
}

/* The sidebar card: one short line and three quiet buttons. Shown only
   while `visible`; never in the rail, which the CSS hides. */
function interviewCardHTML(visible) {
  if (!visible) return '';
  return '<div class="sb-invite" role="note" aria-label="Talk to the team">'
    + '<div class="sb-invite-t">Got 15 min?</div>'
    + '<div class="sb-invite-d">Tell us what broke and get $50 in OpenRouter credits.</div>'
    + '<div class="sb-invite-row">'
      + '<button class="btn sb-invite-go" data-act="interview:card">Talk to the team</button>'
      + '<button class="btn sb-invite-later" data-act="interview:later">Later</button>'
    + '</div>'
    + '<button class="sb-invite-never" data-act="interview:never">Don’t ask again</button>'
    + '</div>';
}

if (typeof module !== 'undefined') module.exports = {interviewWindowState, interviewMayAsk, interviewCardHTML};
