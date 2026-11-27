/**
 * ATO-2483: the routes behind Settings › Models › "Share this model".
 *
 *   modelShare:get   where the shared model listens, its addresses and key
 *                    (the agent's GET /api/model-share).
 *   modelShare:set   {mode, rotate?}: off / local / network, and a new key.
 *
 * Both answer `{supported: true, ok: true, view}` (model-share.ts),
 * `{supported: false}` for an agent from before the route or a remote agent
 * (its model is on the other computer), or `{supported: true, ok: false,
 * error}`. The key travels to the window only, for Copy; nothing here logs it.
 *
 * The mDNS announcement (model-share-announce.ts) follows the answer: on
 * while the model is shared on the network and listening, off otherwise. It
 * is also brought in line when the agent connects, every 30 s while it runs
 * (a `models share --network` typed in a terminal), and stopped, with a
 * goodbye packet, when the agent stops or the app quits.
 */

import { app, ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import { createShareAnnouncer, type ShareAnnouncer } from "./model-share-announce.js";
import { announcePortOf, isShareMode, readShareAnswer, type ShareView } from "./model-share.js";

export type ShareAnswer =
  | { supported: false }
  | { supported: true; ok: true; view: ShareView }
  | { supported: true; ok: false; error: string };

/** How often a running agent is asked again, so a change made in a terminal reaches the announcement. */
const RESYNC_MS = 30_000;

type ShareClient = Pick<AgentClient, "modelShare" | "isRemote" | "on">;

export function wireModelShareIpc(deps: { client: ShareClient; announcer?: ShareAnnouncer }): void {
  const client = deps.client;
  const announcer = deps.announcer ?? createShareAnnouncer();
  let timer: ReturnType<typeof setInterval> | null = null;

  const ask = async (body?: { mode: string; rotate?: boolean }): Promise<ShareAnswer> => {
    if (client.isRemote) {
      announcer.set(null);
      return { supported: false };
    }
    const res = await client.modelShare(body);
    if (!res.supported) {
      announcer.set(null);
      return { supported: false };
    }
    if (!res.ok) return { supported: true, ok: false, error: res.error };
    const view = readShareAnswer(res.data);
    if (!view) return { supported: true, ok: false, error: "the agent sent no sharing state" };
    announcer.set(announcePortOf(view));
    return { supported: true, ok: true, view };
  };

  ipcMain.handle("modelShare:get", async (): Promise<ShareAnswer> => {
    try {
      return await ask();
    } catch (err) {
      return { supported: true, ok: false, error: String(err) };
    }
  });

  ipcMain.handle("modelShare:set", async (_event, raw: unknown): Promise<ShareAnswer> => {
    const body = raw && typeof raw === "object" ? (raw as { mode?: unknown; rotate?: unknown }) : {};
    if (!isShareMode(body.mode)) return { supported: true, ok: false, error: "Pick off, this computer or the local network." };
    try {
      return await ask({ mode: body.mode, ...(body.rotate === true ? { rotate: true } : {}) });
    } catch (err) {
      return { supported: true, ok: false, error: String(err) };
    }
  });

  client.on("status", (status: { state?: string }) => {
    if (status.state === "connected") {
      void ask().catch(() => undefined);
      if (!timer) {
        timer = setInterval(() => void ask().catch(() => undefined), RESYNC_MS);
        timer.unref?.();
      }
      return;
    }
    if (status.state === "starting") return;
    // stopped, error, missing binary: the shared model is gone with the agent.
    if (timer) clearInterval(timer);
    timer = null;
    announcer.set(null);
  });

  app.on("will-quit", () => announcer.stop());
}
