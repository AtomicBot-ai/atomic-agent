import { describe, expect, it } from "vitest";

import { searchHttp } from "./search-http.js";
import type { runCommand as RunCommandType } from "../../../../sandbox/command-runner.js";
import type { HostLookup } from "../../web-fetch-ssrf-guard.js";

const publicLookup: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

/**
 * Builds the curl stdout envelope that `parseCurlMeta` expects: the response
 * body followed by the trailing `__ATOMIC_WEB_SEARCH_META__status|ct|redir|size`
 * block that searchHttp appends via `curl -w`.
 */
function stubCurlStdout(body: string): string {
  return `${body}\n__ATOMIC_WEB_SEARCH_META__200|text/html||${body.length}`;
}

function capturingRunCommand(calls: string[][]): typeof RunCommandType {
  return (async (_command: string, args: string[]) => {
    calls.push(args);
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: stubCurlStdout("<html></html>"),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }) as unknown as typeof RunCommandType;
}

describe("searchHttp curl argv", () => {
  it("passes --globoff so bracketed URLs are not read as curl ranges", async () => {
    // Search queries routinely carry `[`/`]`/`{`/`}`. Without --globoff curl
    // reads them as its own range/set syntax and fails with "bad range in URL".
    const calls: string[][] = [];
    const url =
      "https://search.example/search?q=filter:original:.*[Dd]ewey.*" +
      "&range=[202102010000+TO+202104300000]";
    await searchHttp({
      url,
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
      runCommand: capturingRunCommand(calls),
      lookup: publicLookup,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--globoff");
    // The bracketed URL still reaches curl verbatim as the final operand.
    expect(calls[0]![calls[0]!.length - 1]).toContain("[Dd]ewey");
  });
});
