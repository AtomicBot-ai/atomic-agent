import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { handleLinearRequest } from "./linear-server.js";

const SECRET = "lin_wh_test_secret";
const NOW = 1_800_000_000_000;

function signed(payload: Record<string, unknown>, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload));
  return { body, signature: createHmac("sha256", secret).update(body).digest("hex") };
}

function req(over: Partial<Parameters<typeof handleLinearRequest>[0]> = {}) {
  const { body, signature } = signed({ type: "Comment", action: "create", webhookTimestamp: NOW, data: { id: "c1" } });
  return { method: "POST", url: "/linear/webhook", signature, delivery: "d-1", body, ...over };
}

describe("handleLinearRequest", () => {
  it("answers 200 and hands over a correctly signed, fresh delivery", () => {
    const out = handleLinearRequest(req(), SECRET, NOW);
    expect(out.status).toBe(200);
    expect(out.payload?.type).toBe("Comment");
    expect(out.delivery).toBe("d-1");
  });

  it("answers 401 to a forged signature and dispatches nothing", () => {
    const forged = signed({ type: "Comment", action: "create", webhookTimestamp: NOW }, "attacker-secret");
    expect(handleLinearRequest(req(forged), SECRET, NOW)).toEqual({ status: 401 });
    expect(handleLinearRequest(req({ signature: undefined }), SECRET, NOW)).toEqual({ status: 401 });
  });

  it("answers 401 to a correctly signed but stale delivery (replay)", () => {
    const stale = signed({ type: "Comment", action: "create", webhookTimestamp: NOW - 10 * 60 * 1000 });
    expect(handleLinearRequest(req(stale), SECRET, NOW)).toEqual({ status: 401 });
  });

  it("refuses a non-JSON body: 400 when signed, 401 when not", () => {
    const body = Buffer.from("not json");
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(handleLinearRequest(req({ body, signature }), SECRET, NOW)).toEqual({ status: 400 });
    expect(handleLinearRequest(req({ body, signature: "f".repeat(64) }), SECRET, NOW)).toEqual({ status: 401 });
  });

  it("answers 404 off the webhook path and 405 for other methods", () => {
    expect(handleLinearRequest(req({ url: "/api/messages" }), SECRET, NOW).status).toBe(404);
    expect(handleLinearRequest(req({ method: "GET" }), SECRET, NOW).status).toBe(405);
  });
});
