import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commandIssuedSecrets,
  createApiKeyCommandSource,
  resetCommandIssuedSecrets,
  sharedApiKeyCommandSource,
  type RunKeyCommand,
} from "./api-key-command.js";

const TOKEN = "ya29.test-token-not-real";

afterEach(() => {
  resetCommandIssuedSecrets();
});

function stubRun(outputs: string[]): RunKeyCommand & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (argv: readonly string[]) => {
    calls.push([...argv]);
    return outputs[Math.min(calls.length - 1, outputs.length - 1)]!;
  }) as RunKeyCommand & { calls: string[][] };
  run.calls = calls;
  return run;
}

describe("createApiKeyCommandSource", () => {
  it("returns the trimmed command output and reuses it inside the TTL", async () => {
    let now = 0;
    const run = stubRun([`${TOKEN}\n`]);
    const source = createApiKeyCommandSource(["gcloud", "auth", "print-access-token"], {
      label: "google-vertex",
      ttlMs: 1000,
      now: () => now,
      run,
    });

    await expect(source.get()).resolves.toBe(TOKEN);
    now = 999;
    await expect(source.get()).resolves.toBe(TOKEN);
    expect(run.calls).toEqual([["gcloud", "auth", "print-access-token"]]);
  });

  it("runs the command again once the TTL has passed", async () => {
    let now = 0;
    const run = stubRun(["first-token", "second-token"]);
    const source = createApiKeyCommandSource(["tok"], { label: "p", ttlMs: 1000, now: () => now, run });

    await expect(source.get()).resolves.toBe("first-token");
    now = 1000;
    await expect(source.get()).resolves.toBe("second-token");
    expect(run.calls).toHaveLength(2);
  });

  it("runs the command again after invalidate (the 401 path)", async () => {
    const run = stubRun(["old-token-value", "new-token-value"]);
    const source = createApiKeyCommandSource(["tok"], { label: "p", run });

    await source.get();
    source.invalidate();
    await expect(source.get()).resolves.toBe("new-token-value");
  });

  it("shares one run between concurrent callers", async () => {
    let release: (value: string) => void = () => undefined;
    const run = vi.fn(
      () => new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const source = createApiKeyCommandSource(["tok"], { label: "p", run });

    const both = Promise.all([source.get(), source.get()]);
    release(TOKEN);
    await expect(both).resolves.toEqual([TOKEN, TOKEN]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never puts the command output in an error", async () => {
    const twoLines = createApiKeyCommandSource(["tok"], {
      label: "p",
      run: stubRun([`${TOKEN}\nsecond-line-secret`]),
    });
    const failure = await twoLines.get().catch((err: Error) => err.message);
    expect(failure).toContain("more than one token");
    expect(failure).not.toContain(TOKEN);
    expect(failure).not.toContain("second-line-secret");

    const empty = createApiKeyCommandSource(["tok"], { label: "p", run: stubRun(["  \n"]) });
    await expect(empty.get()).rejects.toThrow(/printed nothing/);

    const crashed = createApiKeyCommandSource(["gcloud"], {
      label: "google-vertex",
      run: async () => {
        throw Object.assign(new Error(`boom ${TOKEN}`), { code: 1, stderr: TOKEN });
      },
    });
    const crash = await crashed.get().catch((err: Error) => err.message);
    expect(crash).toBe('apiKeyCommand for "google-vertex" failed (gcloud): exit code 1');
  });

  it("offers the latest output to the secret scrubber, one value per provider", async () => {
    const source = createApiKeyCommandSource(["tok"], {
      label: "google-vertex",
      run: stubRun(["first-token-value", "second-token-value"]),
    });
    await source.get();
    source.invalidate();
    await source.get();

    expect(commandIssuedSecrets()).toEqual([
      { label: "google-vertex-key-command", value: "second-token-value" },
    ]);
  });

  it("refuses an empty command", () => {
    expect(() => createApiKeyCommandSource([], { label: "p" })).toThrow(/non-empty/);
    expect(() => createApiKeyCommandSource([""], { label: "p" })).toThrow(/non-empty/);
  });

  it("runs the real command without a shell", async () => {
    // `$(whoami)` reaches the child as a literal argument: no shell ever
    // sees it to expand.
    const source = createApiKeyCommandSource(
      [process.execPath, "-e", "process.stdout.write(process.argv[1])", "$(whoami)"],
      { label: "p" },
    );
    await expect(source.get()).resolves.toBe("$(whoami)");
  });

  it("names a missing binary without running anything else", async () => {
    const source = createApiKeyCommandSource(["atomic-agent-no-such-binary-xyz"], { label: "p" });
    await expect(source.get()).rejects.toThrow(/command not found/);
  });
});

describe("sharedApiKeyCommandSource", () => {
  it("hands every provider instance the same source for one entry", () => {
    const a = sharedApiKeyCommandSource(["gcloud", "auth", "print-access-token"], "google-vertex");
    const b = sharedApiKeyCommandSource(["gcloud", "auth", "print-access-token"], "google-vertex");
    const other = sharedApiKeyCommandSource(["gcloud", "auth", "print-access-token"], "google-vertex-2");
    expect(a).toBe(b);
    expect(other).not.toBe(a);
  });
});
