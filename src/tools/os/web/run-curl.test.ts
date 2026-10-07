import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CommandResult,
  runCommand as RunCommandType,
} from "../../../sandbox/command-runner.js";
import type { ToolContext } from "../../tool-registry.js";
import {
  explainCurlStderr,
  NO_REVOKE_FLAG,
  resetCurlRevocationFlagForTests,
  REVOKE_BEST_EFFORT_FLAG,
  runCurl,
} from "./run-curl.js";
import { buildOsWebFetchTool } from "./web-fetch.js";
import { executeGuardedHttpRequest } from "./http-request-fetch.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

const ARGS = ["-sS", "--max-time", "30", "--", "https://en.wikipedia.org/"];
const OPTIONS = { cwd: "/tmp" };

/** The line Schannel curl prints when the CRL/OCSP host is unreachable. */
const REVOCATION_OFFLINE =
  "curl: (35) schannel: next InitializeSecurityContext failed: " +
  "CRYPT_E_REVOCATION_OFFLINE (0x80092013) - The revocation function " +
  "was unable to check revocation because the revocation server was offline.";

/** What curl < 7.70 prints for the best-effort flag, before any I/O. */
const UNKNOWN_BEST_EFFORT =
  "curl: option --ssl-revoke-best-effort: is unknown\n" +
  "curl: try 'curl --help' or 'curl --manual' for more information";

function result(
  args: string[],
  over: Partial<CommandResult> = {},
): CommandResult {
  return {
    command: "curl",
    args,
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    inputTruncated: false,
    ...over,
  };
}

/** A curl that knows only the flags in `known`; others fail as unknown. */
function fakeCurl(known: readonly string[]) {
  return vi.fn(async (_command: string, args: string[], _options?: unknown) => {
    const unknown = args.find(
      (a) =>
        (a === REVOKE_BEST_EFFORT_FLAG || a === NO_REVOKE_FLAG) &&
        !known.includes(a),
    );
    if (unknown === undefined) return result(args);
    return result(args, {
      exitCode: 2,
      stdout: "",
      stderr: `curl: option ${unknown}: is unknown\ncurl: try 'curl --help'`,
    });
  });
}

afterEach(() => {
  resetCurlRevocationFlagForTests();
});

describe("runCurl", () => {
  it("leaves the argv untouched off Windows", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const run = fakeCurl([]);
      await runCurl(run as unknown as typeof RunCommandType, ARGS, OPTIONS, {
        platform,
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith("curl", ARGS, OPTIONS);
    }
  });

  it("asks Schannel for best-effort revocation on Windows", async () => {
    const run = fakeCurl([REVOKE_BEST_EFFORT_FLAG, NO_REVOKE_FLAG]);
    const res = await runCurl(
      run as unknown as typeof RunCommandType,
      ARGS,
      OPTIONS,
      { platform: "win32" },
    );
    expect(res.exitCode).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      "curl",
      [REVOKE_BEST_EFFORT_FLAG, ...ARGS],
      OPTIONS,
    );
  });

  it("falls back to --ssl-no-revoke once on a curl without best-effort", async () => {
    const run = fakeCurl([NO_REVOKE_FLAG]);
    const seams = { platform: "win32" as const };
    const first = await runCurl(
      run as unknown as typeof RunCommandType,
      ARGS,
      OPTIONS,
      seams,
    );
    expect(first.exitCode).toBe(0);
    expect(run.mock.calls.map((c) => c[1][0])).toEqual([
      REVOKE_BEST_EFFORT_FLAG,
      NO_REVOKE_FLAG,
    ]);

    // The choice sticks: the next request goes straight to the fallback.
    run.mockClear();
    await runCurl(run as unknown as typeof RunCommandType, ARGS, OPTIONS, seams);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1][0]).toBe(NO_REVOKE_FLAG);
  });

  it("resends the same stdin body on the fallback", async () => {
    // Safe even for a POST: the unknown option fails before any I/O.
    const run = fakeCurl([NO_REVOKE_FLAG]);
    const options = { cwd: "/tmp", input: '{"a":1}' };
    await runCurl(run as unknown as typeof RunCommandType, ARGS, options, {
      platform: "win32",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[2]).toEqual(options);
  });

  it("does not treat an unrelated exit 2 as an old curl", async () => {
    const run = vi.fn(async (_c: string, args: string[]) =>
      result(args, { exitCode: 2, stderr: "curl: (2) Failed initialization" }),
    );
    const res = await runCurl(
      run as unknown as typeof RunCommandType,
      ARGS,
      OPTIONS,
      { platform: "win32" },
    );
    expect(res.exitCode).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns the fallback's own failure when neither flag is known", async () => {
    const run = fakeCurl([]);
    const res = await runCurl(
      run as unknown as typeof RunCommandType,
      ARGS,
      OPTIONS,
      { platform: "win32" },
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(res.stderr).toContain(NO_REVOKE_FLAG);
  });

  it("never passes anything that disables certificate validation", async () => {
    const run = fakeCurl([REVOKE_BEST_EFFORT_FLAG, NO_REVOKE_FLAG]);
    await runCurl(run as unknown as typeof RunCommandType, ARGS, OPTIONS, {
      platform: "win32",
    });
    const argv = run.mock.calls[0]?.[1] ?? [];
    expect(argv).not.toContain("-k");
    expect(argv).not.toContain("--insecure");
  });
});

describe("explainCurlStderr", () => {
  it("rewrites the Schannel revocation-offline failure in plain words", () => {
    const msg = explainCurlStderr(REVOCATION_OFFLINE);
    expect(msg).toMatch(
      /^Windows could not check whether the site's certificate was revoked/,
    );
    expect(msg).toContain("revocation server is unreachable");
    // The raw line stays for diagnostics.
    expect(msg).toContain("CRYPT_E_REVOCATION_OFFLINE");
  });

  it("covers CRYPT_E_NO_REVOCATION_CHECK too", () => {
    const msg = explainCurlStderr(
      "curl: (35) schannel: next InitializeSecurityContext failed: " +
        "Unknown error (0x80092012) - The revocation function was unable " +
        "to check revocation for the certificate.",
    );
    expect(msg).toMatch(/^Windows could not check/);
  });

  it("passes every other curl error through unchanged", () => {
    const raw = "curl: (6) Could not resolve host: nope.invalid";
    expect(explainCurlStderr(raw)).toBe(raw);
    expect(explainCurlStderr(UNKNOWN_BEST_EFFORT)).toBe(UNKNOWN_BEST_EFFORT);
  });
});

describe("the revocation message reaches the tools", () => {
  const lookup: HostLookup = async () => [
    { address: "93.184.216.34", family: 4 },
  ];
  const failing = (async (_c: string, args: string[]) =>
    result(args, {
      exitCode: 35,
      stdout: "",
      stderr: REVOCATION_OFFLINE,
    })) as unknown as typeof RunCommandType;

  it("os.web.fetch reports it in plain words", async () => {
    const tool = buildOsWebFetchTool({
      runCommand: failing,
      lookup,
      sleep: async () => {},
    });
    const ctx: ToolContext = {
      workingDir: "/tmp",
      sessionId: "s1",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
    const res = await tool.run({ url: "https://en.wikipedia.org/" }, ctx);
    expect(res.status).toBe("error");
    expect(res.summary).toContain(
      "Windows could not check whether the site's certificate was revoked",
    );
  });

  it("os.http.request reports it in plain words", async () => {
    await expect(
      executeGuardedHttpRequest(
        "https://en.wikipedia.org/",
        {
          method: "GET",
          headers: {},
          body: undefined,
          timeoutMs: 10_000,
          followRedirects: true,
        },
        {
          runCommand: failing,
          lookup,
          cwd: "/tmp",
          signal: new AbortController().signal,
          maxResponseBytes: 1_000_000,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(/Windows could not check whether the site's certificate/);
  });
});
