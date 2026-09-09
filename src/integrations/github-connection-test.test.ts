import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_API_USER_URL,
  testGithubToken,
  type FetchLike,
} from "./github-connection-test.js";

const TOKEN = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  });
}

describe("testGithubToken", () => {
  it("asks /user with a bearer header and reports the login", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => respond(200, { login: "octocat" }));
    const outcome = await testGithubToken(TOKEN, fetchImpl);
    expect(outcome).toEqual({ ok: true, login: "octocat" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(GITHUB_API_USER_URL);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["User-Agent"]).toBeTruthy();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a rejected token without echoing it", async () => {
    const outcome = await testGithubToken(TOKEN, () => respond(401, {}));
    expect(outcome.ok).toBe(false);
    expect((outcome as { detail: string }).detail).toMatch(/401/);
    expect((outcome as { detail: string }).detail).not.toContain(TOKEN);
  });

  it("tells a rate limit apart from a permissions refusal", async () => {
    const limited = await testGithubToken(TOKEN, () =>
      respond(403, {}, { "x-ratelimit-remaining": "0" }),
    );
    expect((limited as { detail: string }).detail).toMatch(/rate limit/);
    const refused = await testGithubToken(TOKEN, () => respond(403, {}));
    expect((refused as { detail: string }).detail).toMatch(/permissions/);
  });

  it("treats a body without a login as a failure", async () => {
    const outcome = await testGithubToken(TOKEN, () => respond(200, { id: 1 }));
    expect(outcome.ok).toBe(false);
  });

  it("describes a network failure by its errno, never by the token", async () => {
    const err = new Error("fetch failed");
    (err as Error & { cause: unknown }).cause = { code: "ENOTFOUND" };
    const outcome = await testGithubToken(TOKEN, () => Promise.reject(err));
    expect(outcome).toEqual({
      ok: false,
      detail: "cannot reach api.github.com (ENOTFOUND)",
    });
  });

  it("names a timeout as such", async () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    const outcome = await testGithubToken(TOKEN, () => Promise.reject(err));
    expect((outcome as { detail: string }).detail).toMatch(/did not answer in time/);
  });
});
