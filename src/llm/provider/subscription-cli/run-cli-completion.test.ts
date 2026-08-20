import { describe, expect, it } from "vitest";

import { runCliCommand, type CliRunOptions } from "./run-cli-completion.js";
import { SubscriptionCliAuthError } from "./subscription-cli-errors.js";

/**
 * Real children, not a mocked runner: the case these cover is what
 * happens to a pending stdin write when the child stops reading, which
 * only the kernel can produce.
 */
function options(script: string, extra: Partial<CliRunOptions> = {}): CliRunOptions {
  return {
    binary: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    timeoutMs: 15_000,
    maxOutputBytes: 1024 * 1024,
    installHint: "install it",
    authHint: "log in",
    ...extra,
  };
}

/**
 * Past the ~64 KiB pipe buffer. The provider's own comment notes a
 * two-zone prompt "routinely exceeds the 128 KiB single-argument limit",
 * so this is an ordinary session, not a pathological one.
 */
const BIG_PROMPT = "x".repeat(1024 * 1024);

describe("runCliCommand with an undrained prompt", () => {
  it("reports a signed-out CLI as an auth error, not a broken pipe", async () => {
    const script = `
      process.stderr.write("Please run /login to authenticate", () => process.exit(1));
    `;
    await expect(
      runCliCommand(options(script, { input: BIG_PROMPT })),
    ).rejects.toBeInstanceOf(SubscriptionCliAuthError);
  });

  it("refuses a half-delivered prompt even when the CLI exits 0", async () => {
    // `codex` exits 0 even on failure, so without this the caller would
    // parse a completion computed from a prompt we never finished
    // sending and treat it as a good answer.
    const script = `process.stdout.write("{}", () => process.exit(0));`;
    await expect(
      runCliCommand(options(script, { input: BIG_PROMPT })),
    ).rejects.toThrow(/stopped reading the prompt/);
  });

  it("passes a prompt the CLI actually reads straight through", async () => {
    const script = `
      let n = 0;
      process.stdin.on("data", (c) => { n += c.length; });
      process.stdin.on("end", () => process.stdout.write(String(n)));
    `;
    const out = await runCliCommand(options(script, { input: BIG_PROMPT }));
    expect(out.stdout).toBe(String(BIG_PROMPT.length));
  });
});
