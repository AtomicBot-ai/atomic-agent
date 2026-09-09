/**
 * Verify a GitHub token by asking the API who it belongs to.
 *
 * One request, no SDK: `GET /user` answers with the login for any token
 * that authenticates, and with a plain 401 for one that does not. The
 * token travels only in the `Authorization` header of this one call;
 * nothing here logs it, and no failure message interpolates it — a
 * detail string ends up on screen and in the TUI action log.
 */

export const GITHUB_API_USER_URL = "https://api.github.com/user";
const PROBE_TIMEOUT_MS = 10_000;

export type GithubProbeOutcome =
  | { ok: true; login: string }
  | { ok: false; detail: string };

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export async function testGithubToken(
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  signal?: AbortSignal,
): Promise<GithubProbeOutcome> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const combined =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(GITHUB_API_USER_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "atomic-agent",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: combined,
    });
  } catch (err) {
    return { ok: false, detail: describeNetworkFailure(err) };
  }
  if (response.status === 401) {
    return { ok: false, detail: "token rejected by GitHub (401) — expired or revoked?" };
  }
  if (response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    return {
      ok: false,
      detail:
        remaining === "0"
          ? "GitHub rate limit exhausted — try again later"
          : "GitHub refused the token (403) — check its permissions",
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `GitHub answered HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: "GitHub answered with an unreadable body" };
  }
  const login =
    typeof body === "object" && body !== null
      ? (body as { login?: unknown }).login
      : undefined;
  if (typeof login !== "string" || login.length === 0) {
    return { ok: false, detail: "GitHub answered without a login" };
  }
  return { ok: true, login };
}

function describeNetworkFailure(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return "api.github.com did not answer in time";
  }
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string"
    ? `cannot reach api.github.com (${code})`
    : "cannot reach api.github.com";
}
