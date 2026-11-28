import { formatPairingCode } from "./device-code.js";
import type { DeviceSessions } from "./device-sessions.js";
import type { PairedDevice } from "./device-store.js";
import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * ATO-2308: the paired phones, for an admin client (the desktop app's
 * "Connect phone" sheet). Same store as `atag pair`.
 *
 * - `POST /api/devices/pairing`: a new one-time link; answers the path
 *   (`/pair/<token>`) and when it expires. The caller puts its own
 *   reachable origin in front and draws the QR. ATO-2494: also `code`, the
 *   same pairing as a short code to type at `/pair` (the iPhone home-screen
 *   app). Token and code are in this response only, never logged.
 * - `GET /api/devices`: id, name, when paired, last seen (never a hash);
 *   devices idle past 30 days are signed out and not listed (ATO-2494).
 * - `DELETE /api/devices/{id}`: sign one device out (`all` for every one).
 */

function publicDevice(d: PairedDevice): Omit<PairedDevice, "sha256"> {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
}

function off(res: Parameters<HttpHandler>[1]): void {
  sendError(res, 404, openaiError("Device pairing is not available on this server", "invalid_request_error", null, "pairing_off"));
}

export function createDevicePairingHandler(devices: DeviceSessions | null): HttpHandler {
  return (_req, res) => {
    if (!devices) return off(res);
    const result = devices.createPairing();
    if (!result.ok) {
      sendError(res, 500, openaiError(result.error, "server_error"));
      return;
    }
    sendJson(res, 201, {
      path: `/pair/${result.token}`,
      code: formatPairingCode(result.code),
      expiresAt: result.expiresAt,
    });
  };
}

export function createListDevicesHandler(devices: DeviceSessions | null): HttpHandler {
  return (_req, res) => {
    if (!devices) return off(res);
    sendJson(res, 200, { devices: devices.list().map(publicDevice) });
  };
}

export function createRevokeDeviceHandler(devices: DeviceSessions | null): HttpHandler {
  return (_req, res, ctx) => {
    if (!devices) return off(res);
    const id = ctx.params.id ?? "";
    const result = devices.revoke(id);
    if (!result.ok) {
      // A store that cannot be read carries `reason: "store"`; anything else is an unknown id.
      if ("reason" in result) sendError(res, 500, openaiError(result.error, "server_error"));
      else sendError(res, 404, openaiError(result.error, "invalid_request_error", null, "device_not_found"));
      return;
    }
    sendJson(res, 200, { revoked: result.removed.map((d) => d.id) });
  };
}
