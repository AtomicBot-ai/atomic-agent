import { describe, expect, it } from "vitest";
import { checkShellCommandGuard } from "./index.js";

/**
 * `agent.security.argScanThreshold` (ATO-2505) reaches the guard through
 * `ShellGuardPolicy.argScanThreshold`, read on every command.
 */
function guard(cmd: string, args: readonly string[], threshold?: number) {
  return checkShellCommandGuard(
    { cmd, rawArgs: args, cwd: "/tmp/project" },
    {
      isGitRemoteSyncEnabled: () => true,
      ...(threshold === undefined ? {} : { argScanThreshold: () => threshold }),
    },
  );
}

describe("the argument-check threshold (ATO-2505)", () => {
  it("defaults to 0.7: a key file asks in bypass, a project .env does not", () => {
    expect(guard("cat", ["~/.ssh/id_rsa"]).askEveryLevel).toBe(true);
    expect(guard("cat", [".env"]).askEveryLevel).toBeUndefined();
  });

  it("a lower threshold makes the .env read (0.6) ask in bypass too", () => {
    expect(guard("cat", [".env"], 0.6)).toMatchObject({
      rule: "dangerous.read_credentials",
      askEveryLevel: true,
    });
  });

  // Review round 1: a raised threshold silenced the 0.9 key read in
  // bypass, and the model could set it with one config edit. Above 0.7 it
  // now reads as 0.7.
  it.each([0.95, 1])("a raised threshold (%s) still asks for the 0.9 key read", (value) => {
    expect(guard("cat", ["~/.ssh/id_rsa"], value)).toMatchObject({
      rule: "dangerous.read_credentials",
      askEveryLevel: true,
    });
    expect(guard("cat", [".env"], value).askEveryLevel).toBeUndefined();
  });

  it.each([Number.NaN, 0.1, 2, -1])("an unusable value (%s) reads as the default", (value) => {
    expect(guard("cat", ["~/.ssh/id_rsa"], value).askEveryLevel).toBe(true);
    expect(guard("cat", [".env"], value).askEveryLevel).toBeUndefined();
  });
});
