/**
 * ATO-2493: the agent's paired-phone routes, worded for Settings ›
 * Connections › Connect phone (renderer/phone-connect.js). The routes are
 * the core's (src/http/route-devices.ts, ATO-2308):
 *
 *   POST   /api/devices/pairing  -> { path: "/pair/<token>", code, expiresAt }
 *   GET    /api/devices          -> { devices: [{ id, name, createdAt, lastSeenAt }] }
 *   DELETE /api/devices/{id}     -> { revoked: [id] }
 *
 * Pure: the request is handed in (AgentClient.devicesRoute), so
 * test/phone-devices.test.mjs drives every answer. Nothing here throws;
 * a failure is `{ ok: false, error }` with words for a person, and the
 * agent's own text, when there is one, goes in `detail` (shown behind
 * Details, never as the message).
 */

export type DevicesRoute = (method: "GET" | "POST" | "DELETE", path: string) => Promise<{ status: number; body: unknown }>;

export interface PhoneDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export type PhoneFailure = { ok: false; unsupported?: true; error: string; detail?: string };
export type PairingAnswer = { ok: true; url: string; code: string | null; expiresAt: string; others: string[] } | PhoneFailure;
export type DevicesAnswer = { ok: true; devices: PhoneDevice[] } | PhoneFailure;
export type RevokeAnswer = { ok: true } | PhoneFailure;

const UNSUPPORTED = "Connecting a phone needs a newer agent. Update Atomic Agent and try again.";
const UNREACHABLE = "The agent did not answer. Check that it is running, then try again.";

function agentText(body: unknown): string | undefined {
  const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof msg === "string" && msg ? msg.slice(0, 500) : undefined;
}

function agentCode(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : undefined;
}

/** A 404 from an agent without the routes, or with pairing off. */
function unsupported(status: number, body: unknown): boolean {
  if (status !== 404) return false;
  const code = agentCode(body);
  return code === "pairing_off" || /No route for/.test(agentText(body) ?? "");
}

function failure(status: number, body: unknown, error: string): PhoneFailure {
  if (unsupported(status, body)) return { ok: false, unsupported: true, error: UNSUPPORTED };
  const detail = agentText(body);
  return { ok: false, error, ...(detail ? { detail } : {}) };
}

async function call(route: DevicesRoute, method: "GET" | "POST" | "DELETE", path: string): Promise<{ status: number; body: unknown } | PhoneFailure> {
  try {
    return await route(method, path);
  } catch (err) {
    return { ok: false, error: UNREACHABLE, detail: err instanceof Error ? err.message : String(err) };
  }
}

const isFailure = (x: unknown): x is PhoneFailure => (x as { ok?: unknown }).ok === false;

/**
 * A new one-time pairing. `baseUrls`: where phones on this Wi-Fi reach the
 * agent (phone-access.ts lanAddresses with its port), the likeliest first;
 * the QR holds the first one, the rest are shown as a hint.
 */
export async function createPhonePairing(route: DevicesRoute, baseUrls: readonly string[]): Promise<PairingAnswer> {
  if (baseUrls.length === 0) {
    return { ok: false, error: "This computer is not on a network a phone can reach. Connect to Wi-Fi and try again." };
  }
  const res = await call(route, "POST", "/pairing");
  if (isFailure(res)) return res;
  const body = res.body as { path?: unknown; code?: unknown; expiresAt?: unknown } | null;
  if (res.status !== 201 || typeof body?.path !== "string" || !body.path.startsWith("/pair/") || typeof body.expiresAt !== "string") {
    return failure(res.status, res.body, "The agent could not make a pairing code. Try again.");
  }
  const [first, ...others] = baseUrls;
  return {
    ok: true,
    url: `${first}${body.path}`,
    // An agent from before ATO-2494 has no short code: the card then shows the QR only.
    code: typeof body.code === "string" && body.code ? body.code : null,
    expiresAt: body.expiresAt,
    others: others.map((b) => `${b}/panel`),
  };
}

function isDevice(raw: unknown): raw is PhoneDevice {
  const d = raw as Record<string, unknown> | null;
  return !!d && typeof d.id === "string" && typeof d.name === "string"
    && typeof d.createdAt === "string" && typeof d.lastSeenAt === "string";
}

/** The paired phones, the one seen last first. */
export async function listPhoneDevices(route: DevicesRoute): Promise<DevicesAnswer> {
  const res = await call(route, "GET", "");
  if (isFailure(res)) return res;
  const list = (res.body as { devices?: unknown } | null)?.devices;
  if (res.status !== 200 || !Array.isArray(list)) return failure(res.status, res.body, "Could not load the paired phones.");
  const devices = list.filter(isDevice).map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt }));
  devices.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0));
  return { ok: true, devices };
}

const DEVICE_ID = /^[0-9a-f]{8}$/;

/** Sign one phone out. An id already gone counts as done: the phone is signed out either way. */
export async function revokePhoneDevice(route: DevicesRoute, id: string): Promise<RevokeAnswer> {
  if (!DEVICE_ID.test(id)) return { ok: false, error: "That phone is not in the list any more." };
  const res = await call(route, "DELETE", `/${id}`);
  if (isFailure(res)) return res;
  if (res.status === 200) return { ok: true };
  if (res.status === 404 && agentCode(res.body) === "device_not_found") return { ok: true };
  return failure(res.status, res.body, "Could not sign that phone out. Try again.");
}
