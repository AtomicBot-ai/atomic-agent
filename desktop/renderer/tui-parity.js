"use strict";

/* TUI parity (v0.6.7): what the terminal UI already shows, brought to the
   window. Loaded before renderer.js; everything here is read at call time,
   so it may use renderer.js globals (BR, esc, ic, render, S, …) freely.
   Names carry a `tp` prefix so they never collide with renderer.js. */

/* ---- End-of-turn notification (tui.notify, config v71) ------------------
   The notification itself is raised by the main process (main/turn-notify.ts)
   from the same key the TUI reads. This is the Settings › General row that
   switches it. */
const TP_NOTIFY = { loaded: false, loading: false, enabled: null, minMs: 30000, busy: false, error: null };

async function tpNotifyLoad() {
  if (!BR || !BR.configGetKey || TP_NOTIFY.loading) return;
  TP_NOTIFY.loading = true;
  try {
    const res = await BR.configGetKey('tui.notify');
    if (res && res.ok && res.value && typeof res.value === 'object') {
      TP_NOTIFY.enabled = res.value.enabled !== false;
      const ms = Number(res.value.minDurationMs);
      if (Number.isFinite(ms) && ms >= 0) TP_NOTIFY.minMs = ms;
      TP_NOTIFY.error = null;
    } else {
      TP_NOTIFY.error = (res && res.error) || 'could not read this setting';
    }
  } finally {
    TP_NOTIFY.loading = false;
    TP_NOTIFY.loaded = true;
  }
}

async function tpNotifyToggle() {
  if (!BR || TP_NOTIFY.busy || typeof TP_NOTIFY.enabled !== 'boolean') return;
  const next = !TP_NOTIFY.enabled;
  TP_NOTIFY.busy = true; TP_NOTIFY.error = null; render();
  try {
    const res = await BR.configSet('tui.notify.enabled', String(next));
    if (!res || res.ok === false) TP_NOTIFY.error = 'Couldn’t save: ' + ((res && res.error) || 'unknown error');
    await tpNotifyLoad();
  } finally {
    TP_NOTIFY.busy = false; render();
  }
}

/** `30 s`, `2 min` — the notify threshold and the wait budgets. */
function tpSeconds(ms) {
  const s = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  return s < 120 ? s + ' s' : Math.round(s / 60) + ' min';
}

/** The General pane's row. The first draw starts the read and repaints when it lands. */
function tpNotifyRowHTML() {
  if (!TP_NOTIFY.loaded && !TP_NOTIFY.loading && BR) {
    setTimeout(() => { tpNotifyLoad().then(() => { if (S.settings) render(); }); }, 0);
  }
  const known = typeof TP_NOTIFY.enabled === 'boolean';
  const on = known && TP_NOTIFY.enabled;
  const pending = !known && (TP_NOTIFY.loading || !TP_NOTIFY.loaded);
  return '<div class="tk-setrow">'
    + '<div class="body"><div class="t">Notify when a turn ends</div>'
      + '<div class="d">While the window is in the background. Always on failure; on success after '
        + esc(tpSeconds(TP_NOTIFY.minMs)) + ' or more.</div>'
      + (TP_NOTIFY.error ? '<div class="tk-help tk-help--warn">' + esc(TP_NOTIFY.error) + '</div>' : '')
    + '</div>'
    + '<span class="set-state' + (on ? ' on' : '') + '" aria-hidden="true">' + (TP_NOTIFY.busy || pending ? '<span class="tk-spin"></span>' : esc(known ? (on ? 'On' : 'Off') : '—')) + '</span>'
    + '<button class="tk-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="Notify when a turn ends" data-act="notify:toggle"'
      + (!known || TP_NOTIFY.busy ? ' disabled' : '') + ' title="Turn notifications ' + (on ? 'off' : 'on') + '"></button>'
    + '</div>';
}
