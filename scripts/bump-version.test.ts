import { describe, expect, it } from "vitest";

import { BumpVersionError, bumpPackageJson, bumpPackageLock } from "./bump-version.js";

// The shape npm writes, including the Linux-only optional packages whose
// `libc` fields an `npm install --package-lock-only` on macOS dropped (ATO-1641).
const LOCK = `{
  "name": "atomic-agent",
  "version": "0.8.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "atomic-agent",
      "version": "0.8.0",
      "license": "MIT",
      "dependencies": {
        "left-pad": "^1.3.0"
      }
    },
    "node_modules/@img/sharp-linux-x64": {
      "version": "0.34.5",
      "cpu": [
        "x64"
      ],
      "libc": [
        "glibc"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ]
    },
    "node_modules/left-pad": {
      "version": "1.3.0"
    }
  }
}
`;

describe("bumpPackageLock", () => {
  it("changes only the two root version fields", () => {
    const out = bumpPackageLock(LOCK, "0.8.1");
    expect(out).toBe(
      LOCK.replace('"version": "0.8.0",\n  "lockfileVersion"', '"version": "0.8.1",\n  "lockfileVersion"').replace(
        '"name": "atomic-agent",\n      "version": "0.8.0"',
        '"name": "atomic-agent",\n      "version": "0.8.1"',
      ),
    );
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe("0.8.1");
    expect(parsed.packages[""].version).toBe("0.8.1");
    expect(parsed.packages["node_modules/@img/sharp-linux-x64"].libc).toEqual(["glibc"]);
    expect(parsed.packages["node_modules/left-pad"].version).toBe("1.3.0");
  });

  it("is a no-op for the same version", () => {
    expect(bumpPackageLock(LOCK, "0.8.0")).toBe(LOCK);
  });

  it("refuses a lock without the root package", () => {
    const noRoot = LOCK.replace('"": {\n      "name": "atomic-agent",', '"x": {\n      "name": "atomic-agent",');
    expect(() => bumpPackageLock(noRoot, "0.8.1")).toThrow(BumpVersionError);
  });

  it("refuses a version that is not X.Y.Z", () => {
    expect(() => bumpPackageLock(LOCK, "0.8")).toThrow(BumpVersionError);
    expect(() => bumpPackageLock(LOCK, '0.8.1", "x": "')).toThrow(BumpVersionError);
  });
});

describe("bumpPackageJson", () => {
  it("replaces the top-level version and keeps the rest", () => {
    const pkg = `{\n  "name": "atomic-agent",\n  "version": "0.8.0",\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n`;
    expect(bumpPackageJson(pkg, "0.9.0")).toBe(pkg.replace("0.8.0", "0.9.0"));
  });
});
