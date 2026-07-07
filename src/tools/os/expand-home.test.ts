import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome, resolveUserPath } from "./expand-home.js";

describe("expandHome", () => {
  it("expands bare `~` to the home directory", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  it("expands `~/subdir` to `<home>/subdir`", () => {
    expect(expandHome("~/Downloads")).toBe(join(homedir(), "Downloads"));
    expect(expandHome("~/foo/bar/baz.txt")).toBe(
      join(homedir(), "foo/bar/baz.txt"),
    );
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
    expect(expandHome("/Users/someone/file")).toBe("/Users/someone/file");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandHome("src/index.ts")).toBe("src/index.ts");
    expect(expandHome("./foo")).toBe("./foo");
    expect(expandHome("../bar")).toBe("../bar");
  });

  it("does not expand `~user`-style paths", () => {
    expect(expandHome("~root/file")).toBe("~root/file");
    expect(expandHome("~someone")).toBe("~someone");
  });

  it("does not expand tilde that is not at the start", () => {
    expect(expandHome("foo/~/bar")).toBe("foo/~/bar");
    expect(expandHome("file~backup")).toBe("file~backup");
  });

  it("returns empty strings unchanged", () => {
    expect(expandHome("")).toBe("");
  });
});

describe("resolveUserPath", () => {
  const workingDir = "/tmp/project";

  it("expands `~` before deciding whether the path is absolute", () => {
    expect(resolveUserPath("~/Downloads", workingDir)).toBe(
      join(homedir(), "Downloads"),
    );
    expect(resolveUserPath("~", workingDir)).toBe(homedir());
  });

  it.skipIf(process.platform === "win32")(
    "returns already-absolute paths unchanged (POSIX)",
    () => {
      expect(resolveUserPath("/var/log/system.log", workingDir)).toBe(
        "/var/log/system.log",
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "throws on a Unix-absolute path (win32)",
    () => {
      expect(() => resolveUserPath("/var/log/system.log", workingDir)).toThrow(
        /ambiguous on Windows/,
      );
      expect(() => resolveUserPath("/tmp/x", workingDir)).toThrow(
        /ambiguous on Windows/,
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "returns a drive-qualified path unchanged (win32)",
    () => {
      expect(resolveUserPath("C:\\Users\\me\\file.txt", "C:\\work")).toBe(
        "C:\\Users\\me\\file.txt",
      );
    },
  );

  it("resolves relative paths against the working directory", () => {
    expect(resolveUserPath("src/index.ts", workingDir)).toBe(
      resolve(workingDir, "src/index.ts"),
    );
    expect(resolveUserPath("./foo", workingDir)).toBe(
      resolve(workingDir, "./foo"),
    );
  });
});
