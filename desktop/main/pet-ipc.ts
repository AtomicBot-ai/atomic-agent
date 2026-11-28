/**
 * ATO-2391: the desktop pet's routes and its life (pet-window.ts is the
 * window; pet-events.ts, pet-state.ts and pet-prefs.ts the pure parts).
 *
 * It listens to the same AgentClient events main.ts sends the main window
 * (`chat`, `approval`) and sends the page one computed view (pet:view).
 * ATO-2513: while the pet is up it also reads the newest session rows
 * every few seconds (pet-outside-poll.ts), for turns the desktop did not
 * start (cron, Telegram, the terminal). No model is called: it costs no
 * tokens.
 *
 *   pet:attach   the page is up: the view now
 *   pet:hover    the pointer is over the sprite or the bubble (clicks are
 *                taken) or not (they go through to the app below)
 *   pet:drag     start / end of a drag of the sprite; the end saves the spot
 *   pet:answer   Allow once / Deny in the bubble, see below
 *   pet:open     the main window comes up
 *   pet:menu     the sprite's right click: Do Not Disturb, Open, Hide Pet
 *   pet:focus    ATO-2513: a click on the bubble, the window takes the
 *                keyboard (true), or gives it back (false)
 *
 * ATO-2741: the main window's Settings › General row and its palette row
 * show and hide the pet through the same toggle the View menu uses:
 *
 *   pet:prefsGet     the main window reads {enabled, dnd}
 *   pet:setEnabled   the main window shows (true) or hides (false) the pet
 *   pet:prefsChanged sent to the main window on every change, whoever made
 *                    it (the menu, the pet's own menu, Settings), so the
 *                    switch, the palette row and the menu checkbox agree
 *
 * Answers go the way the window's own card answers. When the main window's
 * page is up, the click is handed to it (pet:relayAnswer) and its card is
 * answered by its own code (renderer/pet-relay.js → answerLive), so the
 * card, its receipts, the chat's dot and the analytics are as if the person
 * clicked the card. Only when no page is up, or the page holds no card for
 * the request, main answers it through agent:approve's own function
 * (`approve`). Never both: a relay the page did not confirm in time is
 * reported, not sent again. Allow is allow-once only; the agent's gate,
 * its approval level, rules and risk review stay what decides.
 */

import { app, ipcMain, Menu, type BrowserWindow, type WebContents } from "electron";

import type { AgentClient } from "./agent-client.js";
import { PetTracker, petDecision, type PetDecision } from "./pet-events.js";
import { mergePetPrefs, readPetPrefs, writePetPrefs, type PetPrefs } from "./pet-prefs.js";
import { PetMachine, petView } from "./pet-state.js";
import { openPetWindow, type PetWindow } from "./pet-window.js";
import { startPetOutsidePoll, type PetOutsidePoll } from "./pet-outside-poll.js";
import { wirePetSkins } from "./pet-skins-ipc.js";

export interface PetWiring {
  userData: string;
  platform: NodeJS.Platform;
  /** A smoke run or the first-run probe: the pet never opens. */
  quiet: boolean;
  /** The main window as it is now, or null; never created by this. */
  mainWindow: () => BrowserWindow | null;
  /** Shows and focuses the main window, creating it again when it was closed. */
  showMainWindow: () => void;
  /** agent:approve's own function (main.ts approveFromUi). */
  approve: (approvalId: string, decision: PetDecision) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  /** The menu bar again: its pet checkboxes changed. */
  menuChanged: () => void;
}

export interface PetHub {
  prefs(): PetPrefs;
  toggle(): void;
  /** ATO-2741: Settings' switch; a no-op when the pet is already that way. */
  setEnabled(on: boolean): void;
  toggleDnd(): void;
  /** ATO-2513: the main window comes up with "Make your own pet" open. */
  openMaker(): void;
  /** A request was answered elsewhere (the window's card, its question card). */
  approvalAnswered(approvalId: string): void;
}

const RELAY_TIMEOUT_MS = 4_000;

type RelayResult = { handled: boolean; ok?: boolean; error?: string };

/** The resolve route's error, a string or `{message}` (renderer.js approvalNotWaiting reads it the same way). */
function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  const m = e && typeof e === "object" ? (e as { message?: unknown }).message : undefined;
  return typeof m === "string" ? m : "";
}

export function wirePetIpc(client: AgentClient, w: PetWiring): PetHub {
  const tracker = new PetTracker();
  let prefs = readPetPrefs(w.userData);
  const machine = new PetMachine(Date.now());
  machine.setDoNotDisturb(prefs.dnd);
  let pet: PetWindow | null = null;
  let outside: PetOutsidePoll | null = null;
  let timer: NodeJS.Timeout | null = null;
  const relays = new Map<string, (r: RelayResult) => void>();
  let relaySeq = 0;
  let shownId: string | null = null;   // ATO-2513: the request the last view put in the bubble

  const save = (patch: Partial<PetPrefs>) => {
    prefs = mergePetPrefs(prefs, patch);
    writePetPrefs(w.userData, prefs);
  };

  const view = () => {
    const now = Date.now();
    // This window's own turns first (they know a tool call from thinking), then outside ones (ATO-2513).
    const activity = tracker.activity(now) ?? outside?.turns.activity(now) ?? null;
    const out = machine.step({ activity, waiting: tracker.pending().length > 0 }, now);
    if (timer) { clearTimeout(timer); timer = null; }
    if (out.nextAt !== null) timer = setTimeout(refresh, Math.max(16, out.nextAt - now));
    const v = petView(out.state, machine.doNotDisturb, tracker.pending());
    shownId = v.approval?.approvalId ?? null;
    return v;
  };
  function refresh(): void {
    const v = view();
    pet?.send("pet:view", v);
  }

  const isPet = (wc: WebContents) => !!pet && !pet.win.isDestroyed() && pet.win.webContents === wc;
  const isMain = (wc: WebContents) => {
    const main = w.mainWindow();
    return !!main && !main.isDestroyed() && main.webContents === wc;
  };

  const open = () => {
    if (pet || w.quiet || !prefs.enabled) return;
    const opened = openPetWindow(prefs, w.platform, () => {
      if (pet !== opened) return;
      pet = null;
      outside?.stop();
      outside = null;
    });
    pet = opened;
    outside ??= startPetOutsidePoll({
      read: (limit) => client.recentSessions(limit),
      tracker,
      changed: (endings) => {
        const now = Date.now();
        for (const e of endings) {
          tracker.sessionEnded(e.sessionId);
          machine.ended(e.ending, now);
        }
        refresh();
      },
    });
  };
  const close = () => {
    const p = pet;
    pet = null;
    outside?.stop();
    outside = null;
    p?.close();
  };

  client.on("chat", (ev: unknown) => {
    const ending = tracker.observeChat(ev, Date.now());
    if (ending) machine.ended(ending, Date.now());
    refresh();
  });
  client.on("approval", (ev: unknown) => {
    if (tracker.observeApproval(ev, Date.now())) refresh();
  });

  /* The pet lives with the main window: it opens when that window does (at
     launch, again after it was closed) and closes with it, so the last
     window closing still quits off macOS and the Dock reopen finds it. */
  app.on("browser-window-created", (_event, created) => {
    setImmediate(() => {
      if (created.isDestroyed() || created !== w.mainWindow()) return;
      open();
      created.once("closed", close);
    });
  });
  const main = w.mainWindow();
  if (main && !main.isDestroyed()) {
    main.once("closed", close);
    open();
  }
  app.on("before-quit", close);

  const relay = (approvalId: string, decision: PetDecision): Promise<RelayResult> => {
    const main = w.mainWindow();
    if (!main || main.isDestroyed() || main.webContents.isLoading()) return Promise.resolve({ handled: false });
    const reqId = `pet-${Date.now()}-${++relaySeq}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        relays.delete(reqId);
        resolve({ handled: true, ok: false, error: "No answer from the main window. Open Atomic Agent to check." });
      }, RELAY_TIMEOUT_MS);
      relays.set(reqId, (r) => { clearTimeout(t); relays.delete(reqId); resolve(r); });
      main.webContents.send("pet:relayAnswer", { reqId, approvalId, decision: decision === "allow-once" ? "allow" : "deny" });
    });
  };

  ipcMain.handle("pet:attach", (event) => (isPet(event.sender) ? view() : null));

  ipcMain.on("pet:hover", (event, inside: unknown) => {
    if (isPet(event.sender)) pet?.setHover(inside === true);
  });

  ipcMain.on("pet:focus", (event, on: unknown) => {
    if (isPet(event.sender)) pet?.keyboard(on === true);
  });

  ipcMain.on("pet:drag", (event, phase: unknown) => {
    if (!isPet(event.sender) || !pet) return;
    if (phase === "start") pet.dragStart();
    else if (phase === "end") {
      const at = pet.dragEnd();
      if (at) save({ x: at.x, y: at.y });
    }
  });

  ipcMain.handle("pet:answer", async (event, raw: unknown) => {
    if (!isPet(event.sender)) return { ok: false, error: "not the pet" };
    // Only the request the bubble shows now: an answer meant for one that changed is refused (petDecision).
    const shown = shownId ? tracker.approval(shownId) : null;
    const picked = petDecision(raw, shown);
    if ("error" in picked || !shown) return { ok: false, error: "error" in picked ? picked.error : "This request is no longer waiting." };
    const relayed = await relay(shown.approvalId, picked.decision);
    if (relayed.handled) return { ok: relayed.ok !== false, ...(relayed.error ? { error: relayed.error } : {}) };
    const res = await w.approve(shown.approvalId, picked.decision);
    const data = res.data && typeof res.data === "object" ? (res.data as { resolved?: unknown; error?: unknown }) : null;
    if (res.ok && data?.resolved === true) return { ok: true };
    if (/not pending/i.test(`${errorText(data?.error)} ${res.error ?? ""}`)) {
      tracker.approvalAnswered(shown.approvalId);
      refresh();
      return { ok: false, error: "This request is no longer waiting." };
    }
    return { ok: false, error: "The agent did not take the answer. Open Atomic Agent to answer it." };
  });

  ipcMain.on("pet:relayResult", (event, raw: unknown) => {
    if (!isMain(event.sender)) return;
    const r = raw && typeof raw === "object" ? (raw as { reqId?: unknown; handled?: unknown }) : {};
    const done = typeof r.reqId === "string" ? relays.get(r.reqId) : undefined;
    done?.({ handled: r.handled === true });
  });

  const showMain = () => {
    w.showMainWindow();
    // The pet is a panel that never made the app active.
    if (w.platform === "darwin") app.focus({ steal: true });
  };
  ipcMain.on("pet:open", (event) => { if (isPet(event.sender)) showMain(); });

  /* ATO-2741: the main window's switch and palette row follow every change. */
  const shown = () => ({ enabled: prefs.enabled, dnd: prefs.dnd });
  const changed = () => {
    w.menuChanged();
    const main = w.mainWindow();
    if (!main || main.isDestroyed() || main.webContents.isLoading()) return;
    try { main.webContents.send("pet:prefsChanged", shown()); } catch { /* the page going away */ }
  };

  /* ATO-2513: made pets and the one that shows (pet-skins-ipc.ts). */
  const openMaker = () => {
    showMain();
    const main = w.mainWindow();
    if (!main || main.isDestroyed()) return;
    const send = () => { if (!main.isDestroyed()) main.webContents.send("pet:openMaker"); };
    if (main.webContents.isLoading()) main.webContents.once("did-finish-load", send);
    else send();
  };
  const skins = wirePetSkins({
    userData: w.userData,
    isMain,
    isPet,
    sendToPet: (channel, payload) => pet?.send(channel, payload),
    openMaker,
  });

  const hub: PetHub = {
    prefs: () => ({ ...prefs }),
    toggle() {
      save({ enabled: !prefs.enabled });
      if (prefs.enabled) open();
      else close();
      changed();
    },
    setEnabled(on) {
      if (prefs.enabled !== on) hub.toggle();
    },
    toggleDnd() {
      save({ dnd: !prefs.dnd });
      machine.setDoNotDisturb(prefs.dnd);
      refresh();
      changed();
    },
    openMaker,
    approvalAnswered(approvalId) {
      if (tracker.approvalAnswered(approvalId)) refresh();
    },
  };

  ipcMain.on("pet:menu", (event) => {
    if (!isPet(event.sender) || !pet) return;
    Menu.buildFromTemplate([
      { label: "Do Not Disturb", type: "checkbox", checked: prefs.dnd, click: () => hub.toggleDnd() },
      { label: "Open Atomic Agent", click: showMain },
      ...skins.menuItems(),
      { type: "separator" },
      { label: "Hide Pet", click: () => hub.toggle() },
    ]).popup({ window: pet.win });
  });

  ipcMain.handle("pet:prefsGet", (event) => (isMain(event.sender) ? shown() : null));
  ipcMain.handle("pet:setEnabled", (event, on: unknown) => {
    if (!isMain(event.sender) || typeof on !== "boolean") return null;
    hub.setEnabled(on);
    return shown();
  });

  return hub;
}
