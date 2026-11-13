import { describe, expect, it, vi } from "vitest";

import { TeamsAuthError } from "./msteams-jwt.js";
import { handleTeamsRequest } from "./msteams-server.js";

const body = JSON.stringify({ type: "message", id: "a1", serviceUrl: "https://smba.invalid/" });

function req(over: Partial<Parameters<typeof handleTeamsRequest>[0]> = {}) {
  return { method: "POST", url: "/api/messages", authorization: "Bearer x.y.z", body, ...over };
}

describe("handleTeamsRequest", () => {
  it("answers 200 and hands over the activity when the token verifies", async () => {
    const verify = vi.fn(async () => undefined);
    const out = await handleTeamsRequest(req(), { verify });
    expect(out.status).toBe(200);
    expect(out.activity?.id).toBe("a1");
    expect(verify).toHaveBeenCalledWith("Bearer x.y.z", expect.objectContaining({ id: "a1" }));
  });

  it("answers 401 and dispatches nothing when the token is refused", async () => {
    const verify = vi.fn(async () => {
      throw new TeamsAuthError("bad token signature");
    });
    const out = await handleTeamsRequest(req(), { verify });
    expect(out).toEqual({ status: 401 });
  });

  it("answers 401 to unauthenticated garbage", async () => {
    const verify = vi.fn();
    expect(await handleTeamsRequest(req({ authorization: undefined, body: "nope" }), { verify })).toEqual({ status: 401 });
    expect(verify).not.toHaveBeenCalled();
  });

  it("answers 404 off the messages path and 405 for other methods", async () => {
    const verify = vi.fn();
    expect((await handleTeamsRequest(req({ url: "/admin" }), { verify })).status).toBe(404);
    expect((await handleTeamsRequest(req({ method: "GET" }), { verify })).status).toBe(405);
    expect(verify).not.toHaveBeenCalled();
  });
});
