/**
 * ATO-2493: Settings › Connections › Connect phone (renderer/phone-connect.js).
 *
 *   phone:status      -> { ok, remote, enabled, listening, addresses }
 *   phone:setEnabled  { enabled } -> status, or { ok: false, busy } while a turn runs
 *   phone:pair        -> { ok, url, code, expiresAt, others }   a QR link and a short code
 *   phone:devices     -> { ok, devices }
 *   phone:revoke      { id } -> { ok }
 *
 * The switch ("Allow phones on this Wi-Fi", phone-access.ts) restarts the
 * agent on 0.0.0.0 or back on 127.0.0.1, so it is refused while a turn is
 * running anywhere, the way a folder change is (workspace-busy.ts). A
 * remote agent (another computer) is paired on that computer, with
 * `atag pair`; this card says so and changes nothing.
 */

import { ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import { ALL_INTERFACES_HOST, lanAddresses, readPhoneAccess, writePhoneAccess } from "./phone-access.js";
import { createPhonePairing, listPhoneDevices, revokePhoneDevice } from "./phone-devices.js";
import { workspaceChangeBusy } from "./workspace-busy.js";

type PhoneClient = Pick<AgentClient, "status" | "isRemote" | "listenHost" | "turnsInFlight" | "turnsHealth" | "devicesRoute" | "stop" | "start">;

const BUSY_CHECK_MS = 5_000;

export interface PhoneStatus {
  ok: true;
  remote: boolean;
  /** The saved switch. */
  enabled: boolean;
  /** The running agent listens beyond this computer (the switch took effect). */
  listening: boolean;
  /** `http://<lan address>:<port>`, the likeliest first; empty when not listening. */
  addresses: string[];
}

function statusOf(client: PhoneClient): PhoneStatus {
  const listening = !client.isRemote && client.status.state === "connected" && client.listenHost === ALL_INTERFACES_HOST;
  const port = client.status.port;
  return {
    ok: true,
    remote: client.isRemote,
    enabled: readPhoneAccess(),
    listening,
    addresses: listening && port ? lanAddresses().map((a) => `http://${a}:${port}`) : [],
  };
}

const route = (client: PhoneClient) => (method: "GET" | "POST" | "DELETE", path: string) => client.devicesRoute(method, path);

export function wirePhoneIpc(client: PhoneClient): void {
  ipcMain.handle("phone:status", () => statusOf(client));

  ipcMain.handle("phone:setEnabled", async (_event, raw: unknown) => {
    const enabled = (raw as { enabled?: unknown } | null)?.enabled === true;
    if (client.isRemote) return { ok: false, error: "This app uses the agent on another computer. Pair a phone there with atag pair." };
    const busy = await workspaceChangeBusy({
      windowTurns: () => client.turnsInFlight,
      agentTurns: async () => {
        if (client.status.state !== "connected") return null;
        const h = (await client.turnsHealth()) as { busyTurns?: unknown } | null;
        return typeof h?.busyTurns === "number" && Number.isFinite(h.busyTurns) ? h.busyTurns : null;
      },
      timeoutMs: BUSY_CHECK_MS,
    });
    if (busy) return { ok: false, busy: true, error: "Not while a turn is running. Try again when the agent is idle." };
    try {
      writePhoneAccess(enabled);
    } catch (err) {
      return { ok: false, error: "Could not save this setting.", detail: err instanceof Error ? err.message : String(err) };
    }
    // The agent listens on its new address from its next start.
    await client.stop();
    await client.start();
    return statusOf(client);
  });

  ipcMain.handle("phone:pair", () => {
    const st = statusOf(client);
    if (!st.listening) return { ok: false, error: "Turn on Allow phones on this Wi-Fi first." };
    return createPhonePairing(route(client), st.addresses);
  });

  ipcMain.handle("phone:devices", () => {
    if (client.isRemote || client.status.state !== "connected") return { ok: false, error: "The agent is not running." };
    return listPhoneDevices(route(client));
  });

  ipcMain.handle("phone:revoke", (_event, raw: unknown) => {
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return { ok: false, error: "That phone is not in the list any more." };
    return revokePhoneDevice(route(client), id);
  });
}
