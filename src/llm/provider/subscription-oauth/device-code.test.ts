import { describe, expect, it, vi } from "vitest";

import { pollDeviceToken, requestDeviceAuthorization, type DeviceCodeOptions } from "./device-code.js";
import type { FetchLike } from "./oauth-types.js";

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

/** Fake clock advanced only by the injected sleep, so polling needs no real waits. */
function harness(responses: Array<[number, unknown]>) {
  let clock = 0;
  const slept: number[] = [];
  const fetchImpl = vi.fn<FetchLike>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return jsonResponse(next[0], next[1]);
  });
  const options: DeviceCodeOptions = {
    deviceAuthorizationUrl: "https://auth.example.test/device",
    tokenUrl: "https://auth.example.test/token",
    clientId: "client-under-test",
    fetch: fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  };
  return { options, fetchImpl, slept };
}

const DEVICE = { device_code: "device-secret", user_code: "ABCD-EFGH", verification_uri: "https://auth.example.test/activate", expires_in: 600, interval: 2 };

describe("device code grant", () => {
  it("parses the device authorization response", async () => {
    const { options } = harness([[200, { ...DEVICE, verification_uri_complete: "https://auth.example.test/activate?c=1" }]]);
    await expect(requestDeviceAuthorization(options)).resolves.toEqual({
      deviceCode: "device-secret",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example.test/activate",
      verificationUriComplete: "https://auth.example.test/activate?c=1",
      expiresAt: 600_000,
      intervalMs: 2_000,
    });
  });

  it("keeps polling on authorization_pending and backs off on slow_down", async () => {
    const { options, fetchImpl, slept } = harness([
      [200, DEVICE],
      [400, { error: "authorization_pending" }],
      [400, { error: "slow_down" }],
      [400, { error: "authorization_pending" }],
      [200, { access_token: "access-secret", expires_in: 60 }],
    ]);
    const authorization = await requestDeviceAuthorization(options);
    const tokens = await pollDeviceToken(options, authorization);
    expect(tokens.accessToken).toBe("access-secret");
    expect(slept).toEqual([2_000, 2_000, 7_000, 7_000]);
    const body = new URLSearchParams(fetchImpl.mock.calls[1]![1].body);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body.get("device_code")).toBe("device-secret");
  });

  it("stops with device_code_expired on expired_token", async () => {
    const { options } = harness([[200, DEVICE], [400, { error: "expired_token" }]]);
    const authorization = await requestDeviceAuthorization(options);
    await expect(pollDeviceToken(options, authorization)).rejects.toMatchObject({ code: "device_code_expired" });
  });

  it("stops locally once the code lifetime is used up", async () => {
    const { options, fetchImpl } = harness([
      [200, { ...DEVICE, expires_in: 5 }],
      [400, { error: "authorization_pending" }],
      [400, { error: "authorization_pending" }],
    ]);
    const authorization = await requestDeviceAuthorization(options);
    await expect(pollDeviceToken(options, authorization)).rejects.toMatchObject({ code: "device_code_expired" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("maps access_denied to authorization_denied", async () => {
    const { options } = harness([[200, DEVICE], [400, { error: "access_denied" }]]);
    const authorization = await requestDeviceAuthorization(options);
    await expect(pollDeviceToken(options, authorization)).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("honors cancellation", async () => {
    const { options, fetchImpl } = harness([[200, DEVICE]]);
    const authorization = await requestDeviceAuthorization(options);
    const controller = new AbortController();
    controller.abort();
    await expect(pollDeviceToken({ ...options, signal: controller.signal }, authorization)).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never puts the device code in error messages", async () => {
    const { options } = harness([[200, DEVICE], [400, { error: "server_error", error_description: "device-secret" }]]);
    const authorization = await requestDeviceAuthorization(options);
    const error = await pollDeviceToken(options, authorization).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: "token_request_failed", oauthError: "server_error" });
    expect(error.message).not.toContain("device-secret");
  });
});
