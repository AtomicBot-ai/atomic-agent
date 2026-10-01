import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 22 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=22`.
 *
 * 22 — New chat, pressed while a chat was still loading, did not stay new.
 * openSession awaited the session fetch and then wrote that chat's
 * transcript, and the session the next message continues, into the window
 * without asking whether the person had moved on: the old chat landed in the
 * new one and the next message went to the old session. The reload a stopped
 * or finished turn starts (onChatEvent) takes the same path. The full suite's
 * r4SeamTest tripped on it as `marks 3→3`: two stale turns under its probe.
 *
 * No turn reaches the agent and nothing is written to it. GET
 * /api/sessions/{id} is answered by a stand-in on the window's own IPC (a
 * webContents handler is asked before ipcMain's; a probe proves it before
 * anything relies on it) that holds an answer until the check lets it go: a
 * slow agent, on cue. The chats are staged rows with ids nothing else uses,
 * opened by clicking them; New chat is the sidebar's own button; a turn's end
 * is a frame on the real agent:chat channel. The reads that still go out (the
 * session list after a frame, a landed chat's parked steers and trace) find
 * nothing of the staged ids. What the check staged comes back out, and the
 * window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type View = { sessionId: string; agentSession: string | null; busy: boolean; rows: string[]; screen: string; seen: string[]; ob: boolean };
type Seam = { added: number; markedBefore: number; markedAfter: number; busy: boolean };
type Payload = { sessionId?: unknown };

const PREFIX = "smoke-t22-";
const PROBE = `${PREFIX}probe`;
const REFUSAL = "smoke t22: this turn stays in the window";
const q = (v: unknown) => JSON.stringify(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Finished turns as the store keeps them: a question, then its reply. */
const turns = (tag: string, n: number) => Array.from({ length: n }, (_, i) => [
  { kind: "user", text: `smoke t22: ${tag} question ${i + 1}` },
  { kind: "assistant_reply", text: `smoke t22: ${tag} answer ${i + 1}` },
]).flat();
const loaded = (id: string, list: unknown[]) => ({ ok: true, data: { id, turns: list } });

/** GET /api/sessions/{id} as a slow agent: an answer asked for with hold() waits for release(). */
class SlowAgent {
  private readonly holds = new Map<string, number>();
  private readonly asked = new Map<string, number>();
  private readonly held: Array<{ id: string; answer: (value: unknown) => void }> = [];

  readonly handler = (_event: unknown, id: unknown): unknown => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT22: true } };
    const n = this.holds.get(sid) ?? 0;
    if (n > 0) {
      this.holds.set(sid, n - 1);
      this.asked.set(sid, (this.asked.get(sid) ?? 0) + 1);
      return new Promise((answer) => { this.held.push({ id: sid, answer }); });
    }
    // Anything else (a row being named, the context chip) is not part of the check.
    return { ok: false, error: "smoke t22: not answered while the check runs" };
  };

  hold(id: string): void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
  }

  /** Until `count` loads of `id` are being held, at most three seconds. */
  async waitFor(id: string, count: number): Promise<boolean> {
    const t0 = Date.now();
    while ((this.asked.get(id) ?? 0) < count && Date.now() - t0 < 3000) await wait(20);
    return (this.asked.get(id) ?? 0) >= count;
  }

  /** Answers the oldest held load of `id`. */
  release(id: string, value: unknown): void {
    const at = this.held.findIndex((h) => h.id === id);
    if (at >= 0) this.held.splice(at, 1)[0]!.answer(value);
  }

  releaseAll(): void {
    this.holds.clear();
    for (const h of this.held.splice(0)) h.answer({ ok: false, error: "smoke t22: let go at the end of the check" });
  }
}

/* Shared by every probe below. */
const H = String.raw`
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const mine = (x) => typeof x === 'string' && x.indexOf('smoke-t22-') === 0;
  const text = (n) => (n ? (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  // A chat in the sidebar as the agent's list carries it, already named, so nothing goes off to name it.
  const open = (id, t) => {
    for (let i = SESSIONS.length - 1; i >= 0; i--) if (SESSIONS[i].id === id) SESSIONS.splice(i, 1);
    SESSIONS.unshift({id, t, named: true, titled: true, updatedAt: Date.now(), status: '', turnCount: 2});
    render();
    const row = document.querySelector('#sidebar [data-ses="' + id + '"]');
    if (row) row.click();
    return !!row;
  };
  const newChat = () => {
    const b = document.querySelector('#sidebar .sb-new[data-act="session:new"]');
    if (b) b.click();
    return !!b;
  };
  const view = () => ({sessionId: S.sessionId, agentSession: S.agentSession, busy: !!S.busy,
    rows: S.log.map((m) => m.k + ':' + String(m.text || '').slice(0, 70)),
    screen: text(document.getElementById('scroller')).slice(0, 300),
    seen: Object.keys(PREFS.seen).filter(mine), ob: !!(window.__ob && window.__ob().open)});
`;
const VIEW = `(() => { ${H} return view(); })()`;

/* The window as the check found it; RESTORE puts it back. */
const KEEP = `(() => {
  window.__t22keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    history: S.history, room: S.room, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId, stick: S.stick,
    settings: S.settings, toasts: S.toasts.slice(), had: 'turnStartedAt' in S, started: S.turnStartedAt, fz: FZ.live,
    stamp: CTX055.stamp, plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;
const RESTORE = `(async () => { ${H}
  await tick(150);   // the answers let go just before this are dealt with first
  const k = window.__t22keep; delete window.__t22keep;
  if (k) {
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.history = k.history; S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId; S.reasonId = k.reasonId;
    S.stick = k.stick; S.settings = k.settings; S.toasts = k.toasts;
    if (k.had) S.turnStartedAt = k.started; else delete S.turnStartedAt;
    FZ.live = k.fz; CTX055.stamp = k.stamp; Object.assign(PLAN, k.plan);
  }
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const sid of [...PENDING_APPROVALS.keys()]) if (mine(sid)) PENDING_APPROVALS.delete(sid);
  for (const sid of [...ATTN]) if (mine(sid)) ATTN.delete(sid);
  for (let i = SESSIONS.length - 1; i >= 0; i--) if (mine(SESSIONS[i].id)) SESSIONS.splice(i, 1);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
  renderToasts(); render();
  await refreshSessions();
  refreshContext();
  return true;
})()`;

/* Whatever the window does with an answer it was handed happens before the
   reply to a later request on the same channel; a beat on top for the repaint. */
async function settle(js: Js): Promise<void> {
  await js<unknown>(`BR.session(${q(PROBE)}).then(() => new Promise((res) => setTimeout(res, 150)))`);
}

const has = (v: View | null, tag: string) => !!v && (v.rows.some((r) => r.includes(`smoke t22: ${tag}`)) || v.screen.includes(`smoke t22: ${tag}`));
const LOADING = "system:loading session…";

export async function checks22(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const w = wins[0] ?? null;
  const agent = new SlowAgent();
  let kept = false;
  try {
    for (const x of wins) x.webContents.ipc.handle("agent:session", agent.handler);
    const probe = await js<{ data?: { smokeT22?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (!w || typeof probe !== "object" || probe?.data?.smokeT22 !== true) {
      check("T22: a stand-in on the window's IPC answers the session fetch first", false,
        `${JSON.stringify(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    await newChatWhileLoading(js, check, agent, wins);
    await failedLoadAfterNewChat(js, check, agent);
    await reloadAfterStop(js, check, agent, w);
    await anotherChatWhileLoading(js, check, agent);
    await sameChatTwice(js, check, agent, w);
  } finally {
    /* The held answers are let go and the stand-in comes off before anything
       else is awaited: a renderer call that never settles here would
       otherwise leave it answering every session fetch for the rest of the
       suite (guarded() moves on after 180 s, it does not stop this). */
    agent.releaseAll();
    for (const x of wins) if (!x.isDestroyed()) x.webContents.ipc.removeHandler("agent:session");
    if (kept) await js<unknown>(RESTORE);
  }
}

/* (a) A chat is opened and its load is slow; New chat is pressed before it
   arrives. Then r4SeamTest's probe on what is on screen, and the next
   message's session as BR.chat hands it to main. */
async function newChatWhileLoading(js: Js, check: Check, agent: SlowAgent, wins: BrowserWindow[]): Promise<void> {
  const id = `${PREFIX}old`;
  agent.hold(id);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(id)}, 'smoke t22: a chat that loads slowly'); })()`);
  const loading = clicked && (await agent.waitFor(id, 1)) ? await js<View>(VIEW) : null;
  const pressed = await js<boolean>(`(() => { ${H} return newChat(); })()`);
  agent.release(id, loaded(id, turns("OLD", 2)));
  await settle(js);
  const after = await js<View>(VIEW);
  check(
    "T22: New chat pressed while a chat is still loading stays a new chat when that chat's transcript arrives",
    !!loading && loading.sessionId === id && loading.rows[0] === LOADING && pressed
      && after.sessionId === "" && after.agentSession === null && after.rows.length === 0 && !has(after, "OLD"),
    `clicked=${clicked} loading=${JSON.stringify(loading)} pressed=${pressed} → after=${JSON.stringify(after)}`,
  );

  // r4SeamTest plants one finished turn into whatever transcript is up and counts the end marks.
  const seam = await js<Seam>("window.__stampRowShape({llm:{providerId:'no-such-provider-seam', chatModel:'ghost-model'}})");
  check(
    "T22: r4SeamTest's probe then finds only the turn it plants (marks 1→1, not 3→3)",
    seam.added === 1 && seam.markedBefore === 1 && seam.markedAfter === 1 && !seam.busy,
    `marks ${seam.markedBefore}→${seam.markedAfter}, added ${seam.added}, busy=${seam.busy}`,
  );

  // The next message: startLiveTurn's own BR.chat, answered by a stand-in that refuses it.
  const sent: Payload[] = [];
  for (const x of wins) x.webContents.ipc.handle("agent:chat", (_e, payload: unknown) => {
    sent.push((payload ?? {}) as Payload);
    return { ok: false, error: REFUSAL };
  });
  let next: { refused?: boolean; error?: string } = {};
  try {
    next = await js<{ refused?: boolean; error?: string }>(`(async () => { ${H}
      const said = 'smoke t22: the next message';
      try {
        S.log.push({id: nid(), k: 'user', text: said});   // as submit() pushes it
        startLiveTurn(said);
        const t0 = Date.now();
        while (S.busy && Date.now() - t0 < 3000) await tick(25);
        return {refused: S.log.some((m) => m.k === 'system' && String(m.text || '').includes(${q(REFUSAL)}))};
      } catch (e) {
        return {error: String((e && e.stack) || e)};
      }
    })()`);
  } finally {
    for (const x of wins) if (!x.isDestroyed()) x.webContents.ipc.removeHandler("agent:chat");
  }
  check(
    "T22: the next message after it starts a new session instead of continuing the chat that was loading",
    !next.error && next.refused === true && sent.length === 1 && !sent[0]!.sessionId,
    next.error ?? `sent ${sent.length}, session ${JSON.stringify(sent.map((p) => p.sessionId ?? null))}`,
  );
}

/* (b) The same, when the slow load ends in an error: the error belongs to the
   chat that was left, not to the new one. */
async function failedLoadAfterNewChat(js: Js, check: Check, agent: SlowAgent): Promise<void> {
  const id = `${PREFIX}gone`;
  agent.hold(id);
  const clicked = await js<boolean>(`(() => { ${H} return open(${q(id)}, 'smoke t22: a chat whose load fails'); })()`);
  const held = clicked && (await agent.waitFor(id, 1));
  const pressed = await js<boolean>(`(() => { ${H} return newChat(); })()`);
  agent.release(id, { ok: false, error: "smoke t22: the agent did not answer" });
  await settle(js);
  const after = await js<View>(VIEW);
  check(
    "T22: a load that fails after New chat leaves no error line in the new chat",
    held && pressed && after.sessionId === "" && after.rows.length === 0,
    `held=${held} pressed=${pressed} → after=${JSON.stringify(after)}`,
  );
}

/* (c) The chat on screen is one whose turn ran on while the person was
   elsewhere: its stored snapshot is up, the stream is not in it (openSession's
   `live` arm). Stop ends the turn, and its aborted frame reloads the chat; New
   chat is pressed before the reload is back. */
async function reloadAfterStop(js: Js, check: Check, agent: SlowAgent, w: BrowserWindow): Promise<void> {
  const id = `${PREFIX}ran`;
  const turn = `${PREFIX}turn-stopped`;
  agent.hold(id);
  await js<boolean>(`(() => { ${H}
    S.sessionId = ${q(id)}; S.agentSession = ${q(id)}; S.room = 'chat'; S.streamId = null; S.busy = true;
    S.log = [{id: nid(), k: 'user', text: 'smoke t22: RAN question 1'},
             {id: nid(), k: 'system', text: 'a turn is still running here — the reply lands when it finishes'}];
    RUNNING.set(${q(turn)}, ${q(id)});
    render();
    return true;
  })()`);
  w.webContents.send("agent:chat", { turnId: turn, kind: "aborted", error: null });
  const reloading = (await agent.waitFor(id, 1)) ? await js<View>(VIEW) : null;
  const pressed = await js<boolean>(`(() => { ${H} return newChat(); })()`);
  agent.release(id, loaded(id, turns("RAN", 1)));
  await settle(js);
  const after = await js<View>(VIEW);
  check(
    "T22: the reload a stopped turn starts does not land over a New chat pressed before it came back",
    !!reloading && reloading.rows[0] === LOADING && pressed
      && after.sessionId === "" && after.agentSession === null && after.rows.length === 0 && !has(after, "RAN"),
    `reloading=${JSON.stringify(reloading)} pressed=${pressed} → after=${JSON.stringify(after)}`,
  );
}

/* (d) A second chat is opened while the first is still loading. The second
   one's answer lands (the guard keeps the newest load working), then the
   first one's arrives late. */
async function anotherChatWhileLoading(js: Js, check: Check, agent: SlowAgent): Promise<void> {
  const first = `${PREFIX}first`;
  const second = `${PREFIX}second`;
  agent.hold(first);
  agent.hold(second);
  const a = await js<boolean>(`(() => { ${H} return open(${q(first)}, 'smoke t22: the first chat'); })()`) && (await agent.waitFor(first, 1));
  const b = await js<boolean>(`(() => { ${H} return open(${q(second)}, 'smoke t22: the second chat'); })()`) && (await agent.waitFor(second, 1));
  agent.release(second, loaded(second, turns("SECOND", 1)));
  await settle(js);
  const mid = await js<View>(VIEW);
  agent.release(first, loaded(first, turns("FIRST", 1)));
  await settle(js);
  const after = await js<View>(VIEW);
  check(
    "T22: a chat opened while another is still loading keeps its own transcript when the first one arrives",
    a && b && mid.sessionId === second && mid.agentSession === second && has(mid, "SECOND")
      && after.sessionId === second && after.agentSession === second && has(after, "SECOND") && !has(after, "FIRST"),
    `held=${a},${b} mid=${JSON.stringify(mid)} → after=${JSON.stringify(after)}`,
  );
}

/* (e) Two loads of the SAME chat. The person comes back to a chat whose turn
   is still running here (openSession's `live` load), and the turn finishes
   while that load is out, so its done frame starts a second one. The first
   answer was read before the turn ended and arrives first: it must not put
   the chat back to "still running" over the second. */
async function sameChatTwice(js: Js, check: Check, agent: SlowAgent, w: BrowserWindow): Promise<void> {
  const id = `${PREFIX}live`;
  const turn = `${PREFIX}turn-live`;
  agent.hold(id);
  agent.hold(id);
  const clicked = await js<boolean>(`(() => { ${H}
    RUNNING.set(${q(turn)}, ${q(id)});
    return open(${q(id)}, 'smoke t22: a chat whose turn is running');
  })()`);
  const first = clicked && (await agent.waitFor(id, 1));
  w.webContents.send("agent:chat", { turnId: turn, kind: "done" });
  const second = first && (await agent.waitFor(id, 2));
  agent.release(id, loaded(id, [{ kind: "user", text: "smoke t22: LIVE question 1" }]));
  await settle(js);
  agent.release(id, loaded(id, turns("LIVE", 1)));
  await settle(js);
  const after = await js<View>(VIEW);
  check(
    "T22: when the same chat loads twice, the older answer arriving first does not bring back a turn that already ended",
    first && second && after.sessionId === id && after.agentSession === id && !after.busy
      && has(after, "LIVE answer 1") && !after.rows.some((r) => r.includes("a turn is still running here")),
    `loads=${first},${second} → after=${JSON.stringify(after)}`,
  );
}
