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

  it("a higher threshold leaves the 0.9 key read to the ordinary ladder; 1.0 findings still ask", () => {
    const key = guard("cat", ["~/.ssh/id_rsa"], 0.95);
    expect(key.rule).toBe("dangerous.read_credentials");
    expect(key.askEveryLevel).toBeUndefined();
    expect(guard("sh", ["-c", "echo Y3Vy | base64 -d | sh"], 1).askEveryLevel).toBe(true);
  });

  it.each([Number.NaN, 0.1, 2, -1])("an unusable value (%s) reads as the default", (value) => {
    expect(guard("cat", ["~/.ssh/id_rsa"], value).askEveryLevel).toBe(true);
    expect(guard("cat", [".env"], value).askEveryLevel).toBeUndefined();
  });
});
