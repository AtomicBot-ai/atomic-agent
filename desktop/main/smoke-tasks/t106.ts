import { BrowserWindow } from "electron";

/**
 * Release-fix checks for ATO-226 and ATO-227 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=106`.
 *
 * ATO-226 — the approval keys matched the character a key types (e.key), so
 * on a Russian layout, where the period key types "ю", ⌘. (Ctrl+. off macOS)
 * did not deny the card on screen, and with no card it did not stop the turn;
 * ⌘K, ⌘N and the rest of the ⌘ shortcuts were dead the same way. Now a key
 * that types a character outside ASCII is read by its physical key (e.code):
 * ⌘ю on the period key is ⌘., and the keypad's Enter and decimal key count as
 * Enter and the period. A Latin layout keeps the character: ⌘: on AZERTY's
 * period key is not ⌘.
 *
 * ATO-227 — Enter with a message in the box while an approval card waited
 * denied the call and sent the words as the reason (the card said so: "Enter
 * denies this call and sends your words to the agent"). Now the message goes
 * to the agent as any message typed under a running turn does, steered into
 * the turn or, when the turn cannot take it, queued as the next one; the box
 * clears, a toast says the request still waits, and the card stays open for
 * its buttons and ⌘↩ / ⌘., whose verdicts carry no words. A queued message
 * runs once the turn has ended.
 *
 * Nothing reaches the agent and the config is not touched. The requests go
 * through the real onApprovalEvent, the keys through the real keydown handler
 * and the turn's end through the real onChatEvent; the verdicts, the steers,
 * the next turn's chat call and the cancel are answered by stand-ins on the
 * window's own IPC (a webContents handler is asked before ipcMain's; a probe
 * proves it first, as in t64) and recorded, never forwarded. What the check
 * staged comes back out and the window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t106-";
const PROBE = `${PREFIX}probe`;
const A = `${PREFIX}chat-a`;
const TURN = `${PREFIX}turn-a`;
const QUIET = "smoke t106: not answered while the check runs";
const DRAFT = "smoke t106: a draft kept through the answers";
const SAID = "smoke t106: a message typed while the card waits";
const PARKED = "smoke t106: a message the turn cannot take";
const q = (v: unknown) => JSON.stringify(v);
const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The agent as this check needs it, on the window's own IPC. */
class StandIn {
  readonly approved: string[] = [];
  readonly cancelled: string[] = [];
  readonly steered: string[] = [];
  readonly chats: string[] = [];
  /** Whether the running turn takes a steer (200 steered), or refuses it (the 409, as the IPC hands it over). */
  takeSteers = true;
  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });
  private readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT106: true } };
    return { ok: false, error: QUIET };
  };
  private readonly approve: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { approvalId?: unknown; decision?: unknown; reason?: unknown };
    this.approved.push(`${String(p.approvalId)} ${String(p.decision)}` + (typeof p.reason === "string" && p.reason ? ` reason=${p.reason}` : ""));
    return { ok: true, data: { resolved: true } };
  };
  private readonly cancel: Handler = (_e, turnId) => { this.cancelled.push(String(turnId)); return true; };
  private readonly steer: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { sessionId?: unknown; text?: unknown };
    this.steered.push(`${String(p.sessionId)}: ${String(p.text)}`);
    return this.takeSteers ? { ok: true, steered: true } : { ok: false, error: "session has no turn accepting steers" };
  };
  private readonly chat: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { messages?: Array<{ content?: unknown }>; sessionId?: unknown };
    this.chats.push(`${String(p.sessionId)}: ${String(p.messages?.[0]?.content ?? "")}`);
    return { ok: true, turnId: `${PREFIX}turn-next-${this.chats.length}` };
  };

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", this.session], ["agent:approve", this.approve], ["agent:cancel", this.cancel],
      ["agent:steer", this.steer], ["agent:chat", this.chat], ["agent:contextPreview", this.quiet],
      ["agent:undeliveredSteers", this.noParked], ["agent:ackSteers", this.quiet], ["cli:traceTools", this.quiet],
      ["app:statPaths", this.quiet], ["cli:chatModelsList", this.quiet],
    ];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }
}

/* Shared by the probes below. */
const H = String.raw`
  const mine = (x) => typeof x === 'string' && (x.indexOf('smoke-t106-') === 0 || x.indexOf('turn:smoke-t106-') === 0);
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const ask = (approvalId) => onApprovalEvent({approvalId, tool: 'os.shell.run', category: 'shell',
    reason: 'smoke t106', preview: 'df -h /', sessionId: ${JSON.stringify(A)}});
  // ⌘ on macOS, Ctrl elsewhere (apprChordOf).
  const CHORD = {metaKey: IS_MAC, ctrlKey: !IS_MAC};
  // A key pressed in the box, where the caret is, with the character a layout types and the key it is on.
  const inBox = (key, code, mods) => {
    const e = document.getElementById('entry');
    if (!e) return;
    if (document.activeElement !== e) e.focus();
    e.dispatchEvent(new KeyboardEvent('keydown', Object.assign({key, code, bubbles: true, cancelable: true}, mods || {})));
  };
  const draft = (text) => {
    S.draft = text; render();
    const e = document.getElementById('entry');
    if (e) { e.value = text; e.focus(); e.setSelectionRange(e.value.length, e.value.length); }
  };
  const view = () => {
    render();
    const e = document.getElementById('entry');
    const a = document.activeElement;
    return {pending: S.pending ? String(S.pending.approvalId || '') : null,
      cards: [...document.querySelectorAll('#scroller .appr[data-appr-id]')].map((n) => n.getAttribute('data-appr-id') || ''),
      entry: e ? e.value : null, focus: a ? (a.id || a.tagName) : '', busy: !!S.busy, overlay: S.overlay || null};
  };
`;
type View = { pending: string | null; cards: string[]; entry: string | null; focus: string; busy: boolean; overlay: string | null };

const KEEP = `(() => {
  window.__t106keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    focused: S.apprFocused, room: S.room, streamId: S.streamId, turnId: S.turnId, stick: S.stick, draft: S.draft,
    entry: (document.getElementById('entry') || {}).value, overlay: S.overlay, toasts: S.toasts.slice(),
    queued: S.queued.slice(), ahead: STEER.ahead, opening: OPENING, owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null,
    plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;

const FORGET = String.raw`
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...APPROVAL_CARDS.keys()]) if (mine(sid)) APPROVAL_CARDS.delete(sid);
  for (const id of [...CLOSED_APPROVALS]) if (mine(id)) CLOSED_APPROVALS.delete(id);
  for (const id of [...LIVE_TURNS.keys()]) if (mine(id)) LIVE_TURNS.delete(id);
  for (const id of [...FIRST_TURNS.keys()]) if (mine(id)) FIRST_TURNS.delete(id);
  for (const id of [...PENDING_CHATS.keys()]) if (mine(id)) PENDING_CHATS.delete(id);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
`;

const RESTORE = `(() => { ${H}
  const k = window.__t106keep; delete window.__t106keep;
  ${FORGET}
  if (S.overlay === 'palette') act('close');
  if (k) {
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.apprFocused = k.focused; S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId; S.stick = k.stick;
    S.draft = k.draft; S.overlay = k.overlay; S.toasts = k.toasts; renderToasts();
    S.queued.length = 0; S.queued.push(...k.queued); STEER.ahead = k.ahead; OPENING = k.opening;
    for (let i = STEER.mine.length - 1; i >= 0; i--) if (String(STEER.mine[i]).indexOf('smoke t106') === 0) STEER.mine.splice(i, 1);
    if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = k.owed;
    Object.assign(PLAN, k.plan);
  }
  render();
  const e = document.getElementById('entry');
  if (e && k && typeof k.entry === 'string') e.value = k.entry;
  return true;
})()`;

/* Chat A on screen, its turn running (its reply row on screen). Nothing the
   person queued can be sent by anything below: the queue on screen is
   emptied (RESTORE gives it back). */
const STAGE = `(() => { ${H}
  ${FORGET}
  if (S.overlay === 'palette') act('close');
  S.queued.length = 0; STEER.ahead = 0;
  if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = false;
  OPENING = null; S.room = 'chat'; S.busy = true; S.pending = null; S.turnId = ${q(TURN)}; PLAN.on = false; PLAN.startedMode = null;
  S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
  const item = {id: nid(), k: 'assistant', text: '', turn: ${q(TURN)}};
  S.log = [{id: nid(), k: 'user', text: 'smoke t106: check free disk space'}, item];
  S.streamId = item.id;
  RUNNING.set(${q(TURN)}, ${q(A)});
  render();
  return true;
})()`;

export async function checks106(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new StandIn();
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT106?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.data?.smokeT106 !== true) {
      check("T106: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    await js<boolean>(STAGE);

    // (a) The key the layout reads: a character outside ASCII by its physical key, an ASCII one as typed.
    const keys = await js<Record<string, string>>(`({
      ru: shortcutKey({key: 'л', code: 'KeyK'}),
      ruShift: shortcutKey({key: 'Л', code: 'KeyK', shiftKey: true}),
      ruPeriod: shortcutKey({key: 'ю', code: 'Period'}),
      ruDigit: shortcutKey({key: '1', code: 'Digit1'}),
      azerty: shortcutKey({key: ':', code: 'Period'}),
      padEnter: shortcutKey({key: 'Enter', code: 'NumpadEnter'}),
      padComma: shortcutKey({key: ',', code: 'NumpadDecimal'}),
      padDelete: shortcutKey({key: 'Delete', code: 'NumpadDecimal'}),
    })`);
    check(
      "T106 (ATO-226): a shortcut is read by the physical key when the layout types a non-Latin character, and as typed on a Latin layout",
      keys["ru"] === "k" && keys["ruShift"] === "K" && keys["ruPeriod"] === "." && keys["ruDigit"] === "1"
        && keys["azerty"] === ":" && keys["padEnter"] === "Enter" && keys["padComma"] === "." && keys["padDelete"] === "Delete",
      show(keys),
    );

    // (b) A card on screen, a draft in the box, a Russian layout: ⌘ю on the period key denies it, the draft kept.
    const mark = agent.approved.length;
    const ru = await js<{ asked: View; denied: View }>(`(async () => { ${H}
      ask(${q(`${PREFIX}approval-1`)});
      draft(${q(DRAFT)});
      const asked = view();
      inBox('ю', 'Period', CHORD);
      await tick(150);
      return {asked, denied: view()};
    })()`);
    const sentRu = agent.approved.slice(mark);
    check(
      "T106 (ATO-226): ⌘. (Ctrl+. off macOS) on a Russian layout, key 'ю' on the Period key, denies the card on screen; the draft and the focus stay",
      ru.asked.pending === `${PREFIX}approval-1` && show(sentRu) === show([`${PREFIX}approval-1 deny`])
        && ru.denied.pending === null && ru.denied.entry === DRAFT && ru.denied.focus === "entry",
      `ru=${show(ru)} sent=${show(sentRu)}`,
    );

    // (c) The next card: the bare key, and ⌘: on AZERTY's period key, answer nothing; ⌘ with the keypad's Enter allows.
    const mark2 = agent.approved.length;
    const pad = await js<{ after: View; allowed: View }>(`(async () => { ${H}
      ask(${q(`${PREFIX}approval-2`)});
      inBox('ю', 'Period');
      inBox(':', 'Period', CHORD);
      await tick(150);
      const after = view();
      inBox('Enter', 'NumpadEnter', CHORD);
      await tick(150);
      return {after, allowed: view()};
    })()`);
    const sentPad = agent.approved.slice(mark2);
    check(
      "T106 (ATO-226): a bare 'ю' and ⌘: on AZERTY's period key answer nothing; ⌘↩ (Ctrl+↩) on the keypad's Enter allows the card, the draft kept",
      pad.after.pending === `${PREFIX}approval-2` && show(pad.after.cards) === show([`${PREFIX}approval-2`])
        && show(sentPad) === show([`${PREFIX}approval-2 allow-once`]) && pad.allowed.pending === null && pad.allowed.entry === DRAFT,
      `pad=${show(pad)} sent=${show(sentPad)}`,
    );

    // (d) And ⌘ with the keypad's decimal key (',' on a Russian keypad) denies the next one.
    const mark3 = agent.approved.length;
    const dec = await js<View>(`(async () => { ${H}
      ask(${q(`${PREFIX}approval-3`)});
      inBox(',', 'NumpadDecimal', CHORD);
      await tick(150);
      return view();
    })()`);
    const sentDec = agent.approved.slice(mark3);
    check(
      "T106 (ATO-226): ⌘ (Ctrl) with the keypad's decimal key denies the card on screen",
      show(sentDec) === show([`${PREFIX}approval-3 deny`]) && dec.pending === null,
      `dec=${show(dec)} sent=${show(sentDec)}`,
    );

    // (e) No card on screen, the turn running: ⌘ю stops it, once; nothing is answered.
    const mark4 = agent.approved.length;
    const stop = await js<View>(`(async () => { ${H}
      inBox('ю', 'Period', CHORD);
      await tick(150);
      return view();
    })()`);
    check(
      "T106 (ATO-226): with no card on screen, ⌘. (Ctrl+.) on a Russian layout stops the chat's turn, once",
      show(agent.cancelled) === show([TURN]) && agent.approved.length === mark4 && !stop.busy && stop.entry === DRAFT,
      `stop=${show(stop)} cancelled=${show(agent.cancelled)}`,
    );

    // (f) ⌘K on a Russian layout ('л' on the K key) opens the command palette.
    const palette = await js<View>(`(async () => { ${H}
      const a = document.activeElement;
      if (a && a !== document.body && a.blur) a.blur();
      document.body.dispatchEvent(new KeyboardEvent('keydown', Object.assign({key: 'л', code: 'KeyK', bubbles: true, cancelable: true}, CHORD)));
      await tick(50);
      const v = view();
      if (S.overlay === 'palette') act('close');
      return v;
    })()`);
    check(
      "T106 (ATO-226): ⌘K (Ctrl+K) on a Russian layout opens the command palette",
      palette.overlay === "palette",
      show(palette),
    );

    // (g) ATO-227. The turn runs again and asks; a message in the box and Enter, as a person sends one.
    await js<boolean>(STAGE);
    const markA = agent.approved.length;
    const typed = await js<{ asked: View; foot: string; after: View; state: string | null; toasts: string[];
      systems: string[]; bubble: boolean }>(`(async () => { ${H}
      ask(${q(`${PREFIX}approval-4`)});
      draft(${q(SAID)});
      const asked = view();
      const foot = (document.querySelector('#apprcard .apprfoot') || {}).textContent || '';
      const toastAt = S.toastId;
      const req = S.pending;
      inBox('Enter', 'Enter');
      await STEER.chain;
      await tick(50);
      const after = view();
      const state = req ? (req.state || null) : 'no request';
      const toasts = S.toasts.filter((t) => t.id > toastAt).map((t) => t.t + ' | ' + (t.s || ''));
      const systems = S.log.filter((m) => m.k === 'system').map((m) => String(m.text || ''));
      const bubble = S.log.some((m) => m.k === 'user' && m.steered && m.text === ${q(SAID)});
      return {asked, foot, after, state, toasts, systems, bubble};
    })()`);
    const sentEnter = agent.approved.slice(markA);
    check(
      "T106 (ATO-227): the card says a message typed below goes to the agent and the request still waits",
      typed.foot === "A message typed below goes to the agent; this request still waits for Allow or Deny.",
      show(typed.foot),
    );
    check(
      "T106 (ATO-227): Enter with a message under a waiting card answers nothing: no verdict, the card stays open",
      typed.asked.pending === `${PREFIX}approval-4` && sentEnter.length === 0 && typed.state === null
        && typed.after.pending === `${PREFIX}approval-4` && show(typed.after.cards) === show([`${PREFIX}approval-4`])
        && !typed.systems.some((t) => /^Denied|deny that call/i.test(t)),
      `typed=${show(typed)} sent=${show(sentEnter)}`,
    );
    check(
      "T106 (ATO-227): the message is steered into the chat's turn, drawn in it, the box clears and a calm toast says the request still waits",
      show(agent.steered) === show([`${A}: ${SAID}`]) && typed.bubble && typed.after.entry === ""
        && typed.systems.includes("steering the running turn — the agent reads it once the request is answered")
        && typed.toasts.some((t) => t.startsWith("The request still waits for your answer | Your message goes to the agent.")),
      `typed=${show(typed)} steered=${show(agent.steered)}`,
    );
    const allowed = await js<View>(`(async () => { ${H}
      inBox('Enter', 'NumpadEnter', CHORD);
      await tick(150);
      return view();
    })()`);
    const sentA = agent.approved.slice(markA);
    check(
      "T106 (ATO-227): the card is answered by its key afterwards, with no words: ⌘↩ (Ctrl+↩) allows it once, and the message is not sent again",
      show(sentA) === show([`${PREFIX}approval-4 allow-once`]) && allowed.pending === null && agent.steered.length === 1,
      `sent=${show(sentA)} allowed=${show(allowed)} steered=${show(agent.steered)}`,
    );

    // (h) The turn cannot take the message (the steer is refused): it is queued as the next turn, the card
    // still waits, ⌘. (on a Russian layout) denies it with no words, and the message runs once the turn ends.
    agent.takeSteers = false;
    const markB = agent.approved.length;
    const markSteer = agent.steered.length;
    const parked = await js<{ after: View; queued: string[]; denied: View; queuedAfterDeny: string[] }>(`(async () => { ${H}
      ask(${q(`${PREFIX}approval-5`)});
      draft(${q(PARKED)});
      inBox('Enter', 'Enter');
      await STEER.chain;
      await tick(50);
      const after = view();
      const queued = S.queued.slice();
      inBox('ю', 'Period', CHORD);
      await tick(150);
      return {after, queued, denied: view(), queuedAfterDeny: S.queued.slice()};
    })()`);
    const sentB = agent.approved.slice(markB);
    check(
      "T106 (ATO-227): a message the turn cannot take is queued as the next turn and the card keeps waiting; ⌘. then denies it with no words",
      show(agent.steered.slice(markSteer)) === show([`${A}: ${PARKED}`]) && parked.after.pending === `${PREFIX}approval-5`
        && parked.after.entry === "" && show(parked.queued) === show([PARKED])
        && show(sentB) === show([`${PREFIX}approval-5 deny`]) && parked.denied.pending === null
        && show(parked.queuedAfterDeny) === show([PARKED]),
      `parked=${show(parked)} sent=${show(sentB)} steered=${show(agent.steered)}`,
    );
    const markChat = agent.chats.length;
    await js<boolean>(`(() => { onChatEvent({turnId: ${q(TURN)}, kind: 'done', payload: {}}); return true; })()`);
    for (let i = 0; i < 20 && agent.chats.length === markChat; i++) await wait(100);
    const drained = await js<string[]>("S.queued.slice()");
    // That turn (the stand-in's) ends too, so the window is not left waiting on it.
    if (agent.chats.length > markChat) {
      await js<boolean>(`(() => { onChatEvent({turnId: ${q(`${PREFIX}turn-next-${agent.chats.length}`)}, kind: 'done', payload: {}}); return true; })()`);
    }
    check(
      "T106 (ATO-227): once the turn has ended, the queued message goes to the agent as the chat's next turn",
      show(agent.chats.slice(markChat)) === show([`${A}: ${PARKED}`]) && drained.length === 0,
      `chats=${show(agent.chats)} queued=${show(drained)}`,
    );
  } finally {
    /* The stand-ins come off before anything else is awaited (see t25). */
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE).catch(() => undefined);
    await wait(50);
  }
}
