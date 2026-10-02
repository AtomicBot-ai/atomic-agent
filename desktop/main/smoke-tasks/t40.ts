import { BrowserWindow } from "electron";

import { accountCannotPay, verifyProviderKey } from "../agent-cli.js";

/**
 * Release-fix checks for backlog item 40 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=40`.
 *
 * 40 — "AI/ML API: out of funds, and the app talks about the local model."
 * A chat on AI/ML API said "hello"; AI/ML API answered 403 "You've run out of
 * funds. Please top up your balance …". The agent did not read that as a
 * billing refusal, fell over to a stopped local server and parked the turn on
 * it, and the window said "No answer from Local models (the local model
 * server isn't running)". The key check in the setup read the same 403 as
 * "didn't accept this key" and threw a good key away.
 *
 * The agent now ends such a turn at once with the provider's own words and
 * marks the error frame `cause: {kind: "billing"}`; its frames list the links
 * that failed before the one a turn waits on (`fallback_failures`, each with
 * its cause). Checked here: the turn's failure line, the waiting strip and
 * its transcript line, and the key check, in main and on the key screen.
 *
 * Every key here is a dummy made up in this file; none is anyone's. Nothing
 * reaches a provider: for the run, main's fetch answers any request carrying
 * one of these dummies itself, and passes everything else through. The setup's
 * writes and switches are answered by stand-ins on the window's own IPC (a
 * webContents handler is asked before ipcMain's; a probe proves it before
 * anything relies on it), so the config is not written. The window's copy of
 * the config is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Fetch = typeof globalThis.fetch;

const MODEL = "openai/gpt-oss-20b";
const LINE = "Key works, but the account has no funds.";
/** AI/ML API's answer for a good key on an account with no funds (item 40's trace). */
const AIML_403 = JSON.stringify({
  title: "Forbidden",
  status: 403,
  message:
    "You've run out of funds. Please top up your balance or update your payment method to continue: https://aimlapi.com/app/billing",
});
/** What the agent says for it (src/llm/provider/openai/openai-http.ts, billingRefusalSentence). */
const AGENT_SENTENCE =
  "AI/ML API refused the request: you've run out of funds. Top up your balance with AI/ML API or pick another provider in the Providers panel.";
/** The same as an older agent wrote it, with the provider's quoted id. */
const QUOTED_SENTENCE =
  '"aimlapi" refused the request: you\'ve run out of funds. Top up your balance with "aimlapi" or pick another provider in the Providers panel.';

/** Each dummy key, and what main's stand-in fetch answers for it. */
const ANSWERS: Record<string, { status: number; body: string }> = {
  "smoke-t40-funds": { status: 403, body: AIML_403 },
  "smoke-t40-pay": { status: 402, body: JSON.stringify({ error: { message: "Insufficient Balance" } }) },
  "smoke-t40-quota": {
    status: 429,
    body: JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    }),
  },
  "smoke-t40-rate": { status: 429, body: JSON.stringify({ error: { message: "Rate limit exceeded, slow down" } }) },
  "smoke-t40-bad": { status: 401, body: JSON.stringify({ error: { message: "Invalid API key" } }) },
  "smoke-t40-forbidden": { status: 403, body: JSON.stringify({ error: { message: "Invalid API key provided" } }) },
};

const q = (v: unknown) => JSON.stringify(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (s: unknown) => JSON.stringify(s);

/** Main's fetch for the run: the dummies are answered here, never on the network. */
function stubFetch(): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const headers = JSON.stringify(init?.headers ?? {});
    const key = Object.keys(ANSWERS).find((k) => headers.includes(`${k}-0123`));
    if (!key) return real(input, init);
    calls.push(key);
    const a = ANSWERS[key]!;
    return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
  }) as Fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

export async function checks40(js: Js, check: Check): Promise<void> {
  const fx = stubFetch();
  try {
    await keyCheck(check, fx.calls);
  } finally {
    fx.restore();
  }
  await failureLine(js, check);
  await waitStrip(js, check);
  await keyScreen(js, check);
}

/* The key check in main: the account's refusal is a key that works. */
async function keyCheck(check: Check, calls: string[]): Promise<void> {
  const ask = (key: string) => verifyProviderKey({ id: "smoke-t40", kind: "aimlapi", apiKey: `${key}-0123456789` }, MODEL);
  const funds = await ask("smoke-t40-funds");
  check(
    "T40: AI/ML API's 403 \"You've run out of funds\" is a key that works on an empty account — not \"rejected this key\"",
    funds.ok === true && funds.checked === true && funds.noFunds === true && funds.error === LINE
      && funds.detail === "You've run out of funds" && calls.includes("smoke-t40-funds"),
    show(funds),
  );
  const pay = await ask("smoke-t40-pay");
  const quota = await ask("smoke-t40-quota");
  check(
    "T40: a 402 and OpenAI's 429 insufficient_quota say the same: the key works, the account has no funds",
    pay.ok === true && pay.noFunds === true && quota.ok === true && quota.noFunds === true && quota.error === LINE,
    show({ pay, quota }),
  );
  const rate = await ask("smoke-t40-rate");
  const bad = await ask("smoke-t40-bad");
  const forbidden = await ask("smoke-t40-forbidden");
  check(
    "T40: a plain rate limit is still a key that works with nothing to add, and a refused key is still refused",
    rate.ok === true && rate.noFunds !== true && bad.ok === false && bad.checked === true && !bad.noFunds
      && /rejected this key/.test(String(bad.error)) && forbidden.ok === false && !forbidden.noFunds,
    show({ rate, bad, forbidden }),
  );
  const rule = {
    "402": accountCannotPay(402, ""),
    "402 asked to wait": accountCannotPay(402, '{"message":"Server busy, retry in 5 s"}'),
    "402 in flight": accountCannotPay(402, '{"error":{"code":"in_flight_budget_exhausted"}}'),
    "403 out of funds": accountCannotPay(403, AIML_403),
    "403 billing": accountCannotPay(403, '{"message":"Billing is not enabled"}'),
    "403 key and billing": accountCannotPay(403, '{"message":"Invalid API key. Check your billing."}'),
    "403 authentication and billing": accountCannotPay(403, '{"message":"Authentication failed. Please check your billing details."}'),
    "403 token and billing": accountCannotPay(403, '{"message":"Invalid token. Check billing."}'),
    "403 plain": accountCannotPay(403, '{"message":"Forbidden"}'),
    "401 out of funds": accountCannotPay(401, '{"message":"insufficient balance"}'),
    "429 empty account": accountCannotPay(429, '{"message":"insufficient balance, please recharge your account"}'),
    "429 insufficient_quota": accountCannotPay(429, '{"error":{"message":"Rate limit reached","code":"insufficient_quota"}}'),
    "429 empty, asked to wait": accountCannotPay(429, '{"message":"insufficient balance"}', true),
    "429 quota words, cooldown": accountCannotPay(429, '{"message":"You exceeded your current quota, please check your plan and billing details. Please retry in 30s."}'),
    "429 top up for rate limits": accountCannotPay(429, '{"message":"Too many requests. Please top up your account to increase your rate limits."}'),
    "429 credits this minute": accountCannotPay(429, '{"message":"Out of credits for this minute"}'),
  };
  const want: Record<string, boolean> = {
    "402": true, "402 asked to wait": false, "402 in flight": false, "403 out of funds": true, "403 billing": true,
    "403 key and billing": false, "403 authentication and billing": false, "403 token and billing": false, "403 plain": false,
    "401 out of funds": false, "429 empty account": true, "429 insufficient_quota": true, "429 empty, asked to wait": false,
    "429 quota words, cooldown": false, "429 top up for rate limits": false, "429 credits this minute": false,
  };
  check(
    "T40: main's rule is the agent's: a 401 is the key, 402 unless it asked to wait, 403 for funds or billing words not about the key, 429 only for an empty account that names no rate limit or cooldown",
    Object.entries(want).every(([k, v]) => rule[k as keyof typeof rule] === v),
    show(Object.fromEntries(Object.entries(rule).filter(([k, v]) => want[k] !== v))),
  );
}

/* The window copy of the config with `id` picked. UNPICK puts it back. */
const PICK = (id: string, kind: string) => `(() => {
  if (!window.__t40pick) window.__t40pick = {cfg: LIVE_CONFIG, want: SWX.want};
  const llm = (LIVE_CONFIG && LIVE_CONFIG.llm) || {};
  const providers = (Array.isArray(llm.providers) ? llm.providers : []).filter((p) => p && p.id !== ${q(id)});
  LIVE_CONFIG = Object.assign({}, LIVE_CONFIG || {}, {llm: Object.assign({}, llm,
    {activeTextProvider: ${q(id)}, providers: providers.concat([{id: ${q(id)}, kind: ${q(kind)}}])})});
  SWX.want = null;
  render();
  return {picked: selActiveProviderId(), name: providerWord(${q(id)})};
})()`;
const UNPICK = `(() => {
  const k = window.__t40pick; delete window.__t40pick;
  if (k) { LIVE_CONFIG = k.cfg; SWX.want = k.want; }
  render();
  return true;
})()`;

/* The turn's failure line: the agent's sentence, in the window's words. */
async function failureLine(js: Js, check: Check): Promise<void> {
  try {
    const pick = await js<{ picked: string; name: string }>(PICK("aimlapi", "aimlapi"));
    const r = await js<Record<string, string>>(`(() => {
      const text = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent || ''; };
      const said = ${q(AGENT_SENTENCE)};
      const quoted = ${q(QUOTED_SENTENCE)};
      const raw = 'openai provider 403: ' + ${q(AIML_403)};
      return {
        marked: text(turnFailureLine({kind: 'error', category: 'transport', error: said,
          payload: {error: said, category: 'transport', cause: {kind: 'billing', status: 403}}})),
        unmarked: text(turnFailureLine({kind: 'error', category: 'transport', error: quoted})),
        listed: text(turnFailureLine({kind: 'error', category: 'transport', error: 'fetch failed',
          payload: {error: 'fetch failed', category: 'transport',
            fallback_failures: [{providerId: 'aimlapi', reason: raw.slice(0, 180), cause: {kind: 'billing', status: 403}}]}})),
        outage: text(turnFailureLine({kind: 'error', category: 'transport', error: 'fetch failed',
          payload: {error: 'fetch failed', category: 'transport'}})),
      };
    })()`);
    const expected = `${pick.name} refused the request: you've run out of funds. Top up your balance with ${pick.name} or pick another provider in Settings › Models.`;
    check(
      "T40: a turn the agent ended on an empty account says so in the provider's words, naming it, pointing at Settings › Models — not \"not answering\"",
      pick.picked === "aimlapi" && r["marked"] === expected && r["unmarked"] === expected
        && !/not answering|Local models|Providers panel/.test(String(r["marked"])),
      show({ expected, r }),
    );
    check(
      "T40: when the turn failed on a later link after AI/ML API refused for money, the line is AI/ML API's refusal",
      r["listed"] === expected,
      show({ expected, listed: r["listed"] }),
    );
    check(
      "T40: an outage with no billing refusal still reads \"not answering\", as before",
      /not answering/.test(String(r["outage"])) && !/refused the request/.test(String(r["outage"])),
      show(r["outage"]),
    );
  } finally {
    await js<boolean>(UNPICK);
  }
}

type Strip = { skipped: boolean; shown: boolean; ann: string; why: string; note: string; clean: boolean };

/* One provider_waiting frame through the window's own handler, read back as a
   person sees it: the strip, and the line the wait put in the transcript
   (item 29's WAIT_VIEW reads the same row). It runs only while the window
   has no turn of its own, and puts back what it touched: the frame goes to a
   stand-in turn whose streaming row sits on a copy of the transcript, the
   wait is dropped without a provider_recovered (no "answered again" status
   line), and the transcript, the room and the status line are restored.
   `clean` says the window is as it was afterwards. */
const WAIT_PROBE = (payload: Record<string, unknown>) => `(() => {
  if (S.turnId || S.streamId || S.busy || RUNNING.size > 0 || WAIT) return {skipped: true};
  const keep = {room: S.room, log: S.log, text: APPSTATUS.text, tone: APPSTATUS.tone, logs: LOGS.length};
  const turnId = 'smoke-t40-wait';
  const stream = {id: 'smoke-t40-stream', k: 'assistant', text: ''};
  S.log = keep.log.concat([stream]);
  S.turnId = turnId; S.streamId = stream.id;
  S.room = 'chat';
  render();
  let seen = {skipped: false, shown: false, ann: '', why: '', note: ''};
  try {
    onChatEvent({turnId, kind: 'provider_waiting', payload: ${q(payload)}});
    const strip = document.querySelector('.statusstrip.waiting');
    const notes = S.log.filter((m) => m.k === 'system' && m.sev === 'pause' && m.note);
    const last = notes[notes.length - 1];
    seen = {skipped: false, shown: !!strip,
      ann: strip ? (strip.querySelector('.ann') || {}).textContent || '' : '',
      why: strip ? (strip.querySelector('.ss-why') || {}).textContent || '' : '',
      note: last ? String(last.text || '') : ''};
  } finally {
    WAIT = null;
    if (WAIT_TICK) { clearInterval(WAIT_TICK); WAIT_TICK = 0; }
    S.turnId = null; S.streamId = null;
    S.log = keep.log; S.room = keep.room;
    APPSTATUS.text = keep.text; APPSTATUS.tone = keep.tone; LOGS.length = keep.logs;
    render();
  }
  const clean = !WAIT && !document.querySelector('.statusstrip.waiting') && S.log === keep.log
    && !S.log.some((m) => m.id === 'smoke-t40-stream') && APPSTATUS.text === keep.text;
  return Object.assign(seen, {clean});
})()`;

const FRAME = {
  object: "atomic.provider_waiting", session_id: "smoke-t40", attempt: 1, waited_ms: 0,
  max_wait_ms: 300_000, next_retry_ms: 30_000, reason: "fetch failed",
  provider_id: "local-llama", cause: { kind: "refused" },
};

/* The waiting strip, and the line the wait adds to the transcript. */
async function waitStrip(js: Js, check: Check): Promise<void> {
  try {
    const pick = await js<{ picked: string; name: string }>(PICK("aimlapi", "aimlapi"));
    const listed = await js<Strip>(WAIT_PROBE({
      ...FRAME,
      fallback_failures: [
        { providerId: "aimlapi", reason: `openai provider 403: ${AIML_403}`.slice(0, 180), cause: { kind: "billing", status: 403 } },
      ],
    }));
    if (listed.skipped) {
      check("T40: the wait probes run with no turn of the window's own live", false, "a turn was live; nothing was injected into it");
      return;
    }
    // The local server's own words after the lead are item 29's (and whatever
    // later items make of a stopped server); this item owns the lead.
    check(
      "T40: a wait on a later link names the picked provider and its reason first, in the strip and in the transcript: \"AI/ML API: out of funds · waiting for Local models\"",
      pick.picked === "aimlapi" && listed.shown && listed.ann === `${pick.name}: out of funds · waiting for Local models`
        && listed.note.startsWith(`${pick.name}: out of funds. `),
      show({ pick, listed }),
    );
    // Item 29's frame, with nothing failed before the link waited on: no lead.
    const plain = await js<Strip>(WAIT_PROBE(FRAME));
    check(
      "T40: a wait with no earlier failure has no lead, as before (item 29)",
      !plain.skipped && plain.shown && plain.ann === "Waiting for Local models" && plain.note.length > 0
        && !plain.note.includes(pick.name) && !plain.note.includes("out of funds"),
      show(plain),
    );
    // The picked provider waited on itself: no lead, whatever the list says.
    const self = await js<Strip>(WAIT_PROBE({
      ...FRAME, provider_id: "aimlapi", cause: { kind: "unreachable" },
      fallback_failures: [{ providerId: "aimlapi", reason: "x", cause: { kind: "billing", status: 403 } }],
    }));
    check(
      "T40: a wait on the picked provider itself is not led by its own name twice",
      !self.skipped && self.shown && self.ann === `Waiting for ${pick.name}` && !self.note.startsWith(`${pick.name}: `),
      show(self),
    );
    check(
      "T40: the wait probes leave the window as they found it: no wait, no stand-in row, the transcript and status line its own",
      listed.clean && plain.clean && self.clean,
      show({ listed: listed.clean, plain: plain.clean, self: self.clean }),
    );
  } finally {
    await js<boolean>(UNPICK);
  }
}

/* The key screen in the setup the composer and Settings › Models open: an
   empty account is a key that works, and the key can be saved. */
async function keyScreen(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const seen: Array<{ ch: string; id?: unknown; on?: unknown }> = [];
  const stand: Record<string, (_e: unknown, payload: unknown) => unknown> = {
    "cli:upsertProvider": (_e, entry) => { seen.push({ ch: "upsert", id: (entry as { id?: unknown } | null)?.id }); return { ok: true, stdout: "", stderr: "" }; },
    "cli:providerModels": () => ({ ok: true, smokeT40: true, models: [{ provider: "aimlapi", id: MODEL, kind: "chat" }] }),
    "cli:removeProvider": (_e, id) => { seen.push({ ch: "remove", id }); return { ok: true, stdout: "", stderr: "" }; },
    "app:unverifiedSet": (_e, p) => { seen.push({ ch: "unverified", on: (p as { on?: unknown } | null)?.on }); return { ok: true }; },
    "cli:verifyProviderKey": () => {
      seen.push({ ch: "verify" });
      return { ok: true, checked: true, status: 403, noFunds: true, error: LINE, detail: "You've run out of funds" };
    },
    "cli:selectCloudModel": () => { seen.push({ ch: "select" }); return { ok: false, error: "smoke t40: nothing is switched" }; },
    "cli:activateProvider": () => { seen.push({ ch: "activate" }); return { ok: false, error: "smoke t40: nothing is switched" }; },
  };
  let staged = false;
  try {
    for (const w of wins) for (const [ch, fn] of Object.entries(stand)) w.webContents.ipc.handle(ch, fn);
    const probe = await js<{ smokeT40?: boolean } | null>("BR.providerModels('smoke-t40-probe', 'aimlapi')").catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.smokeT40 !== true) {
      check("T40: stand-ins on the window's IPC answer the setup's writes first", false, `${q(probe)}; the setup was not driven`);
      return;
    }
    staged = await js<boolean>(`(() => {
      window.__t40Keep = {wiz: Object.assign({}, WIZ), open: SEL.open, err: SEL.err, kind: SEL.kind, addOpen: SEL.addOpen};
      window.__t40Settle = async () => { for (let i = 0; i < 100 && (WIZ.stepping || WIZ.phase === 'verifying'); i++) await new Promise((r) => setTimeout(r, 50)); };
      window.__t40View = () => {
        const save = document.querySelector('#overlays [data-act="wiz:saveUnchecked"]');
        return {phase: WIZ.phase, error: WIZ.error, detail: typeof wizErrDetail === 'function' ? wizErrDetail() : null,
          noFunds: !!(WIZ.uncheckedFor && WIZ.uncheckedFor.noFunds), save: save ? save.textContent : null,
          note: WIZ.noFundsNote || null};
      };
      WIZ.unfinishedId = null; act('close');
      SEL.open = true; SEL.err = null;
      Object.assign(WIZ, {row: KIND_ROWS.find((k) => k.id === 'aimlapi'), phase: 'configure', apiKey: '', baseUrl: '', error: null,
        errorDetail: null, uncheckedFor: null, acceptUnchecked: false, modelChosen: false, forId: null, unfinishedId: null});
      render();
      return !!document.querySelector('#overlays .selpop #wiz-key');
    })()`);
    const asked = await js<Record<string, unknown>>(`(async () => {
      const k = document.querySelector('#overlays .selpop #wiz-key');
      if (!k) return {phase: null};
      k.focus(); k.value = 'smoke-t40-key-0123456789'; k.dispatchEvent(new Event('input', {bubbles: true}));
      act('wiz:next'); await window.__t40Settle(); return window.__t40View();
    })()`);
    check(
      "T40: the key screen says \"Key works, but the account has no funds\" — not \"didn't accept this key\", not \"could not reach\" — and keeps the key",
      staged && asked["phase"] === "configure" && asked["error"] === LINE && asked["noFunds"] === true
        && asked["detail"] === "You've run out of funds" && !seen.some((c) => c.ch === "remove"),
      show({ asked, calls: seen }),
    );
    check(
      "T40: it offers Save key, not Save unchecked",
      asked["save"] === "Save key",
      show(asked["save"]),
    );
    seen.length = 0;
    const saved = await js<Record<string, unknown>>(`(async () => {
      act('wiz:saveUnchecked'); await window.__t40Settle(); return window.__t40View();
    })()`);
    check(
      "T40: Save key goes on to the model, the key saved and not marked unverified, the model step saying the account has no funds",
      saved["phase"] === "pick_model" && saved["note"] === LINE && seen.some((c) => c.ch === "upsert")
        && seen.some((c) => c.ch === "unverified" && c.on === false) && !seen.some((c) => c.ch === "unverified" && c.on === true)
        && !seen.some((c) => c.ch === "remove"),
      show({ saved, calls: seen }),
    );
  } finally {
    /* The setup is closed with nothing left to drop, before the stand-ins come
       off: a removal it still owed would otherwise reach the real config. */
    if (staged) {
      await js<unknown>(`(() => { const k = window.__t40Keep || {};
        WIZ.unfinishedId = null; act('close');
        Object.assign(WIZ, k.wiz || {}, {unfinishedId: null, stepping: false});
        SEL.open = !!k.open; SEL.err = k.err || null; if (k.kind) SEL.kind = k.kind; SEL.addOpen = !!k.addOpen;
        ['__t40Keep', '__t40Settle', '__t40View'].forEach((n) => { delete window[n]; });
        render(); })()`).catch(() => undefined);
    }
    for (const w of wins) if (!w.isDestroyed()) for (const ch of Object.keys(stand)) w.webContents.ipc.removeHandler(ch);
  }
  await wait(50);
}
