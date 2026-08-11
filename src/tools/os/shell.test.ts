import { describe, it, expect } from "vitest";
import { isOpaqueInterpreterShape } from "./shell.js";

describe("isOpaqueInterpreterShape (shape-grant suppression)", () => {
  it("withholds [a] for shell interpreters whose danger lives in their args", () => {
    // `bash -c "<anything>"` and friends: the binary name hides what
    // runs, so a shape grant on them would silence arbitrary code.
    for (const shape of ["bash", "sh", "zsh", "dash", "ksh"]) {
      expect(isOpaqueInterpreterShape(shape)).toBe(true);
    }
  });

  it("allows [a] for ordinary binaries the shape name fully describes", () => {
    for (const shape of ["git", "npm", "ls", "cat", "curl", "rm", "docker"]) {
      expect(isOpaqueInterpreterShape(shape)).toBe(false);
    }
  });
});
