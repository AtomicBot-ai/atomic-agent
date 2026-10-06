import { describe, it, expect } from "vitest";
import { classifyTestCommand } from "./test-command-key.js";

const WD = "/work/project";

function classify(args: unknown, workingDir = WD) {
  return classifyTestCommand("os.shell.run", args, workingDir);
}

describe("classifyTestCommand", () => {
  it("recognizes every classified runner in structured form", () => {
    const cases: Array<{ cmd: string; args?: string[] }> = [
      { cmd: "pytest" },
      { cmd: "python", args: ["-m", "pytest"] },
      { cmd: "python3", args: ["-m", "pytest"] },
      { cmd: "cargo", args: ["test"] },
      { cmd: "go", args: ["test", "./..."] },
      { cmd: "npm", args: ["test"] },
      { cmd: "pnpm", args: ["test"] },
      { cmd: "yarn", args: ["test"] },
      { cmd: "bun", args: ["test"] },
    ];
    for (const c of cases) {
      expect(classify(c), JSON.stringify(c)).not.toBeNull();
    }
  });

  it("recognizes pre-joined command lines in `cmd`", () => {
    expect(classify({ cmd: "pytest -k auth" })).not.toBeNull();
    expect(classify({ cmd: "python -m pytest tests/" })).not.toBeNull();
    expect(classify({ cmd: "cargo test --features foo" })).not.toBeNull();
    // Pre-joined and structured forms of the same invocation share a key.
    expect(classify({ cmd: "pytest -k auth" })!.key).toBe(
      classify({ cmd: "pytest", args: ["-k", "auth"] })!.key,
    );
  });

  it("recognizes a path-qualified runner via its basename", () => {
    const byPath = classify({ cmd: "/usr/local/bin/pytest", args: ["-q"] });
    expect(byPath).not.toBeNull();
    expect(byPath!.label).toBe("pytest -q");
  });

  it("collapses python -m pytest onto the pytest runner", () => {
    const direct = classify({ cmd: "pytest", args: ["-k", "auth"] });
    const viaModule = classify({
      cmd: "python",
      args: ["-m", "pytest", "-k", "auth"],
    });
    expect(viaModule!.key).toBe(direct!.key);
  });

  it("ignores timeoutMs so timeout-only variation collapses to one key", () => {
    const short = classify({ cmd: "pytest", args: ["-q"], timeoutMs: 30_000 });
    const long = classify({ cmd: "pytest", args: ["-q"], timeoutMs: 600_000 });
    const none = classify({ cmd: "pytest", args: ["-q"] });
    expect(short!.key).toBe(long!.key);
    expect(short!.key).toBe(none!.key);
  });

  it("keeps changed cwd distinct and resolves relative cwd against workingDir", () => {
    const root = classify({ cmd: "pytest" });
    const sub = classify({ cmd: "pytest", cwd: "packages/api" });
    expect(sub!.cwd).toBe(`${WD}/packages/api`);
    expect(sub!.key).not.toBe(root!.key);
    // Explicit cwd equal to the working dir matches the implicit one.
    expect(classify({ cmd: "pytest", cwd: WD })!.key).toBe(root!.key);
  });

  it("keeps changed suite/filter arguments distinct", () => {
    const a = classify({ cmd: "pytest", args: ["-k", "auth"] });
    const b = classify({ cmd: "pytest", args: ["-k", "billing"] });
    const bare = classify({ cmd: "pytest" });
    expect(a!.key).not.toBe(b!.key);
    expect(a!.key).not.toBe(bare!.key);
    const feat = classify({ cmd: "cargo", args: ["test", "--features", "x"] });
    const plain = classify({ cmd: "cargo", args: ["test"] });
    expect(feat!.key).not.toBe(plain!.key);
  });

  it("preserves argv boundaries in the key", () => {
    const split = classify({ cmd: "pytest", args: ["-k", "a", "b"] });
    const joined = classify({ cmd: "pytest", args: ["-k", "a b"] });
    expect(split!.key).not.toBe(joined!.key);
  });

  it("accepts a JSON-stringified args array (double-serialising providers)", () => {
    const jsonForm = classify({ cmd: "pytest", args: '["-k","auth"]' });
    const arrayForm = classify({ cmd: "pytest", args: ["-k", "auth"] });
    expect(jsonForm).not.toBeNull();
    expect(jsonForm!.key).toBe(arrayForm!.key);
  });

  it("returns null for unrecognized commands and other tools", () => {
    expect(classify({ cmd: "ls", args: ["-la"] })).toBeNull();
    expect(classify({ cmd: "cargo", args: ["build"] })).toBeNull();
    expect(classify({ cmd: "go", args: ["build"] })).toBeNull();
    expect(classify({ cmd: "npm", args: ["run", "build"] })).toBeNull();
    expect(classify({ cmd: "vitest", args: ["run"] })).toBeNull();
    expect(
      classifyTestCommand("os.fs.read", { path: "pytest" }, WD),
    ).toBeNull();
  });

  it("returns null for compound / env-prefixed / malformed forms", () => {
    // Subshell metacharacters: could be a compound command line.
    expect(classify({ cmd: "pytest | tee out.log" })).toBeNull();
    expect(classify({ cmd: "cd api && pytest" })).toBeNull();
    // Env override on the command line: leading token is not a runner.
    expect(classify({ cmd: "FOO=1 pytest" })).toBeNull();
    // Pre-joined cmd combined with separate args is ambiguous.
    expect(classify({ cmd: "python -m", args: ["pytest"] })).toBeNull();
    // Malformed args shape.
    expect(classify({ cmd: "pytest", args: { k: "auth" } })).toBeNull();
    expect(classify({ cmd: "" })).toBeNull();
    expect(classify(null)).toBeNull();
    expect(classify("pytest")).toBeNull();
  });
});
