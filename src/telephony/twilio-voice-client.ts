import type { TwilioConfig } from "./telephony-config.js";
import { normalizePhoneNumber } from "./telephony-config.js";

/**
 * The Twilio adapter (ATO-24): place one outbound call that speaks a
 * message, and read a call's status. Plain REST over the global `fetch`
 * (injected for tests), no SDK, so no new dependency.
 *
 * Every call costs the user money on their own Twilio account, so this
 * layer never retries a create (a retried POST can dial twice) and is
 * only ever reached behind a per-call approval; the agent tool that does
 * that is the next slice. Errors never carry the auth token.
 */

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
/** Long enough for a booking request, short enough to stay one call. */
export const MAX_SPOKEN_CHARS = 1000;
/** Twilio stops ringing after this many seconds (its own default is 60). */
export const RING_TIMEOUT_S = 30;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type CallStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "failed"
  | "no-answer"
  | "canceled";

export interface CallRecord {
  sid: string;
  status: CallStatus | string;
  to: string;
  /** Seconds; present once the call ended. */
  durationS: number | null;
}

export class TelephonyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Twilio's numeric error code, when it sent one. */
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "TelephonyError";
  }
}

export interface PlaceCallInput {
  /** Who to call, E.164 (spaces and dashes allowed). */
  to: string;
  /** What the call says when answered, read out by Twilio's voice. */
  message: string;
  /** BCP-47 voice language, e.g. `en-US`, `ru-RU`. Twilio's default when left out. */
  language?: string;
}

/** Escape text for an XML text node. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

/** The TwiML for a one-way spoken message. */
export function spokenMessageTwiml(message: string, language?: string): string {
  const lang = language && LANGUAGE.test(language) ? ` language="${language}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say${lang}>${escapeXml(message)}</Say></Response>`;
}

export class TwilioVoiceClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: TwilioConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** Dial `to` from the configured number. One POST, never retried. */
  async placeCall(input: PlaceCallInput, signal?: AbortSignal): Promise<CallRecord> {
    const to = normalizePhoneNumber(input.to);
    if (!to) throw new TelephonyError("the number to call must be E.164, e.g. +14155550100", 0);
    if (to === this.config.fromNumber) throw new TelephonyError("refusing to call the caller number itself", 0);
    const message = input.message.trim();
    if (message.length === 0) throw new TelephonyError("nothing to say: the message is empty", 0);
    if (message.length > MAX_SPOKEN_CHARS) {
      throw new TelephonyError(`the message is longer than ${MAX_SPOKEN_CHARS} characters`, 0);
    }
    const form = new URLSearchParams({
      To: to,
      From: this.config.fromNumber,
      Twiml: spokenMessageTwiml(message, input.language),
      Timeout: String(RING_TIMEOUT_S),
    });
    const body = await this.request("POST", "/Calls.json", form, signal);
    return toRecord(body);
  }

  /** Current state of a call this account placed. */
  async getCall(sid: string, signal?: AbortSignal): Promise<CallRecord> {
    if (!/^CA[0-9a-fA-F]{32}$/.test(sid)) throw new TelephonyError("not a Twilio call SID", 0);
    return toRecord(await this.request("GET", `/Calls/${sid}.json`, undefined, signal));
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    form: URLSearchParams | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const url = `${TWILIO_API_BASE}/Accounts/${this.config.accountSid}${path}`;
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");
    const headers: Record<string, string> = { authorization: `Basic ${auth}`, accept: "application/json" };
    if (form) headers["content-type"] = "application/x-www-form-urlencoded";
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(form ? { body: form.toString() } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new TelephonyError(`Twilio not reachable: ${this.scrub(err instanceof Error ? err.message : String(err))}`, 0);
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // A non-JSON error page: the status alone says enough.
    }
    if (!res.ok) {
      const code = typeof body.code === "number" ? body.code : null;
      const detail = typeof body.message === "string" ? this.scrub(body.message) : `HTTP ${res.status}`;
      throw new TelephonyError(
        res.status === 401 ? "Twilio refused the account SID or auth token" : `Twilio: ${detail}`,
        res.status,
        code,
      );
    }
    return body;
  }

  private scrub(text: string): string {
    return this.config.authToken ? text.split(this.config.authToken).join("***") : text;
  }
}

function toRecord(body: Record<string, unknown>): CallRecord {
  const sid = typeof body.sid === "string" ? body.sid : "";
  if (!sid) throw new TelephonyError("Twilio answered without a call SID", 0);
  const duration = typeof body.duration === "string" ? Number.parseInt(body.duration, 10) : NaN;
  return {
    sid,
    status: typeof body.status === "string" ? body.status : "unknown",
    to: typeof body.to === "string" ? body.to : "",
    durationS: Number.isFinite(duration) ? duration : null,
  };
}
