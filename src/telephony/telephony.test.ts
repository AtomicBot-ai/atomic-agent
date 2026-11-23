import { describe, expect, it, vi } from "vitest";

import {
  MAX_SPOKEN_CHARS,
  TWILIO_API_BASE,
  TelephonyError,
  TwilioVoiceClient,
  normalizePhoneNumber,
  readTelephonyConfig,
  spokenMessageTwiml,
  type FetchLike,
  type TwilioConfig,
} from "./index.js";

/** ATO-24: Twilio with the user's own key. No test reaches the network or places a call. */
const SID = `AC${"a".repeat(32)}`;
const TOKEN = "secret-token-123";
const CONFIG: TwilioConfig = { provider: "twilio", accountSid: SID, authToken: TOKEN, fromNumber: "+14155550100" };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("readTelephonyConfig", () => {
  it("is off and names every missing variable, without values", () => {
    const out = readTelephonyConfig({ TWILIO_AUTH_TOKEN: TOKEN });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("TWILIO_ACCOUNT_SID");
      expect(out.reason).toContain("TWILIO_FROM_NUMBER");
      expect(out.reason).not.toContain("TWILIO_AUTH_TOKEN");
      expect(out.reason).not.toContain(TOKEN);
    }
  });

  it("checks the SID shape and the caller number", () => {
    expect(readTelephonyConfig({ TWILIO_ACCOUNT_SID: "nope", TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM_NUMBER: "+14155550100" }).ok).toBe(false);
    expect(readTelephonyConfig({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM_NUMBER: "4155550100" }).ok).toBe(false);
  });

  it("reads a full set, normalising the number", () => {
    const out = readTelephonyConfig({
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: ` ${TOKEN} `,
      TWILIO_FROM_NUMBER: "+1 (415) 555-0100",
    });
    expect(out).toEqual({ ok: true, config: CONFIG });
  });
});

describe("normalizePhoneNumber", () => {
  it("accepts E.164 with separators and refuses the rest", () => {
    expect(normalizePhoneNumber("+7 916 123-45-67")).toBe("+79161234567");
    expect(normalizePhoneNumber("89161234567")).toBeNull();
    expect(normalizePhoneNumber("+0123456789")).toBeNull();
    expect(normalizePhoneNumber("+1")).toBeNull();
  });
});

describe("spokenMessageTwiml", () => {
  it("escapes the message so it cannot add TwiML verbs", () => {
    const xml = spokenMessageTwiml('Hi</Say><Dial>+19005550000</Dial><Say>"x" & y');
    expect(xml).not.toContain("<Dial>");
    expect(xml).toContain("&lt;/Say&gt;&lt;Dial&gt;");
    expect(xml).toContain("&quot;x&quot; &amp; y");
  });

  it("sets a valid language and ignores an odd one", () => {
    expect(spokenMessageTwiml("hi", "ru-RU")).toContain('<Say language="ru-RU">');
    expect(spokenMessageTwiml("hi", 'en" onload="x')).toContain("<Say>");
  });
});

describe("TwilioVoiceClient", () => {
  it("places one call: right URL, basic auth, form body with From, To and TwiML", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      reply(201, { sid: `CA${"b".repeat(32)}`, status: "queued", to: "+79161234567" }),
    );
    const client = new TwilioVoiceClient(CONFIG, fetchImpl);
    const call = await client.placeCall({ to: "+7 916 123 45 67", message: "Table for two at 7 pm, please.", language: "en-US" });
    expect(call).toEqual({ sid: `CA${"b".repeat(32)}`, status: "queued", to: "+79161234567", durationS: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${TWILIO_API_BASE}/Accounts/${SID}/Calls.json`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("To")).toBe("+79161234567");
    expect(form.get("From")).toBe("+14155550100");
    expect(form.get("Twiml")).toContain("Table for two at 7 pm, please.");
    expect(form.get("Timeout")).toBe("30");
  });

  it("refuses bad input before any request", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const client = new TwilioVoiceClient(CONFIG, fetchImpl);
    await expect(client.placeCall({ to: "12345", message: "hi" })).rejects.toBeInstanceOf(TelephonyError);
    await expect(client.placeCall({ to: "+14155550100", message: "hi" })).rejects.toThrow(/caller number itself/);
    await expect(client.placeCall({ to: "+79161234567", message: "   " })).rejects.toThrow(/empty/);
    await expect(
      client.placeCall({ to: "+79161234567", message: "x".repeat(MAX_SPOKEN_CHARS + 1) }),
    ).rejects.toThrow(/longer than/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never retries a failed create (a retry could dial twice)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => reply(500, { code: 20500, message: "Internal" }));
    const client = new TwilioVoiceClient(CONFIG, fetchImpl);
    await expect(client.placeCall({ to: "+79161234567", message: "hi" })).rejects.toMatchObject({ status: 500, code: 20500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("explains a bad key and never echoes the token", async () => {
    const client401 = new TwilioVoiceClient(CONFIG, async () => reply(401, { code: 20003, message: "Authenticate" }));
    await expect(client401.placeCall({ to: "+79161234567", message: "hi" })).rejects.toThrow(/account SID or auth token/);
    const leaky = new TwilioVoiceClient(CONFIG, async () => reply(400, { message: `bad token ${TOKEN}` }));
    const err = await leaky.placeCall({ to: "+79161234567", message: "hi" }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    const down = new TwilioVoiceClient(CONFIG, async () => {
      throw new Error(`connect failed ${TOKEN}`);
    });
    const err2 = await down.placeCall({ to: "+79161234567", message: "hi" }).catch((e: Error) => e);
    expect((err2 as Error).message).toMatch(/not reachable/);
    expect((err2 as Error).message).not.toContain(TOKEN);
  });

  it("reads a call's status and duration", async () => {
    const sid = `CA${"c".repeat(32)}`;
    const fetchImpl = vi.fn<FetchLike>(async () => reply(200, { sid, status: "completed", to: "+79161234567", duration: "42" }));
    const call = await new TwilioVoiceClient(CONFIG, fetchImpl).getCall(sid);
    expect(call.status).toBe("completed");
    expect(call.durationS).toBe(42);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${TWILIO_API_BASE}/Accounts/${SID}/Calls/${sid}.json`);
    expect(fetchImpl.mock.calls[0]![1].method).toBe("GET");
    await expect(new TwilioVoiceClient(CONFIG, fetchImpl).getCall("../x")).rejects.toBeInstanceOf(TelephonyError);
  });
});
