import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCommandJob } from "./command-job.js";
import { runCommand } from "./command-runner.js";

/**
 * ATO-175: a caller that passes no `env` (rg, trash, proc, curl, window
 * scripts, capability probes, ...) must not hand the child the provider
 * keys `.env` loaded into the agent's own `process.env`. Real children,
 * so the assertion is on what the spawned process actually sees.
 */

const PRINT_ENV = `process.stdout.write(JSON.stringify({
  openai: process.env.OPENAI_API_KEY ?? null,
  bot: process.env.TELEGRAM_BOT_TOKEN ?? null,
  plain: process.env.ATO175_PLAIN ?? null,
}))`;

const saved: Record<string, string | undefined> = {};
const VARS = ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "ATO175_PLAIN"] as const;

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  process.env.OPENAI_API_KEY = "sk-ato175-test";
  process.env.TELEGRAM_BOT_TOKEN = "123:ato175";
  process.env.ATO175_PLAIN = "kept";
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("default child env (ATO-175)", () => {
  it("runCommand without env drops provider keys and keeps ordinary variables", async () => {
    const result = await runCommand(process.execPath, ["-e", PRINT_ENV], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ openai: null, bot: null, plain: "kept" });
  });

  it("runCommand with an explicit env passes it through unchanged", async () => {
    const result = await runCommand(process.execPath, ["-e", PRINT_ENV], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: { ...process.env },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ openai: "sk-ato175-test" });
  });

  it("startCommandJob without env drops provider keys too", async () => {
    const job = startCommandJob(process.execPath, ["-e", PRINT_ENV], {
      cwd: process.cwd(),
    });
    expect(await job.waitFor(10_000)).toBe("exited");
    expect(JSON.parse(job.output().stdout)).toEqual({ openai: null, bot: null, plain: "kept" });
  });
});
