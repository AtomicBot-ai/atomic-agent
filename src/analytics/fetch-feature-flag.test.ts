import { afterEach, describe, expect, it, vi } from "vitest";

import { cachedFeatureFlag, fetchFeatureFlag, resetFeatureFlagCache } from "./fetch-feature-flag.js";
import { POSTHOG_HOST, POSTHOG_PROJECT_KEY } from "./posthog-config.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function reply(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

describe("fetchFeatureFlag", () => {
  afterEach(() => resetFeatureFlagCache());

  it("asks PostHog /flags with the project key and the install id only", async () => {
    const fetchImpl = reply({ flags: { "interview-invite": { enabled: true } } });
    await expect(fetchFeatureFlag({ key: "interview-invite", distinctId: ID, fetchImpl })).resolves.toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`${POSTHOG_HOST}/flags/?v=2`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      api_key: POSTHOG_PROJECT_KEY,
      distinct_id: ID,
      geoip_disable: true,
    });
  });

  it("reads off for a flag that is off or missing", async () => {
    await expect(
      fetchFeatureFlag({ key: "interview-invite", distinctId: ID, fetchImpl: reply({ flags: {} }) }),
    ).resolves.toBe(false);
  });

  it("reads off on an HTTP error, a throw, or a bad body", async () => {
    await expect(
      fetchFeatureFlag({ key: "k", distinctId: ID, fetchImpl: reply({ featureFlags: { k: true } }, false) }),
    ).resolves.toBe(false);
    const throwing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(fetchFeatureFlag({ key: "k", distinctId: ID, fetchImpl: throwing })).resolves.toBe(false);
    const badJson = vi.fn(async () => ({ ok: true, json: async () => { throw new Error("bad"); } })) as unknown as typeof fetch;
    await expect(fetchFeatureFlag({ key: "k", distinctId: ID, fetchImpl: badJson })).resolves.toBe(false);
  });

  it("gives up after the timeout", async () => {
    const hanging = vi.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    await expect(
      fetchFeatureFlag({ key: "k", distinctId: ID, fetchImpl: hanging, timeoutMs: 20 }),
    ).resolves.toBe(false);
  });

  it("fetches nothing under the test runner without an injected fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(fetchFeatureFlag({ key: "k", distinctId: ID, env: { VITEST: "1" } })).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("asks once per process for the same key and id", async () => {
    const fetchImpl = reply({ flags: { k: { enabled: true } } });
    await cachedFeatureFlag({ key: "k", distinctId: ID, fetchImpl });
    await cachedFeatureFlag({ key: "k", distinctId: ID, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
