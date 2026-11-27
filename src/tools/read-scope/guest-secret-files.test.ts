import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { checkGuestRead } from "./guest-reads.js";
import {
  GUEST_SECRET_RG_EXCLUDES,
  isGuestSecretPathUnder,
  isGuestSecretRelPath,
  isSecretFileName,
} from "./guest-secret-files.js";

/** ATO-2703: what a channel guest never sees, even nested inside the working directory. */
describe("guest secret files", () => {
  it("matches env files, keys and credential files by name, any case", () => {
    for (const name of [".env", ".ENV", ".env.local", ".envrc", "id_rsa", "id_ed25519", "server.pem", "tls.KEY", "store.p12", ".netrc", ".npmrc", ".git-credentials", "credentials", "credentials.json", "secrets.yaml"]) {
      expect(isSecretFileName(name), name).toBe(true);
    }
    for (const name of ["env.ts", "environment.md", "README.md", "id_rsa.pub", "keys.ts", "monkey.ts", ".pem", "secret-santa.txt"]) {
      expect(isSecretFileName(name), name).toBe(false);
    }
  });

  it("matches a nested secret file or anything under a secret folder, by relative segments only", () => {
    expect(isGuestSecretRelPath("./config/.env")).toBe(true);
    expect(isGuestSecretRelPath("apps/api/.env.production")).toBe(true);
    expect(isGuestSecretRelPath("deploy\\secrets\\token.txt")).toBe(true);
    expect(isGuestSecretRelPath("home/.ssh/config")).toBe(true);
    expect(isGuestSecretRelPath("src/env/index.ts")).toBe(false);
    expect(isGuestSecretRelPath(".")).toBe(false);
  });

  it("judges a path below a root by the segments under the root, not above it", () => {
    // A working directory that itself sits in a folder named `secrets` is not a secret.
    expect(isGuestSecretPathUnder("/Users/me/secrets/project", "/Users/me/secrets/project/src/a.ts")).toBe(false);
    expect(isGuestSecretPathUnder("/Users/me/secrets/project", "/Users/me/secrets/project/config/.env")).toBe(true);
    expect(isGuestSecretPathUnder("/w", "/elsewhere/.env.local")).toBe(true);
  });

  it("gives ripgrep a negated glob for every rule", () => {
    expect(GUEST_SECRET_RG_EXCLUDES).toContain("!.env");
    expect(GUEST_SECRET_RG_EXCLUDES).toContain("!.env.*");
    expect(GUEST_SECRET_RG_EXCLUDES).toContain("!*.pem");
    expect(GUEST_SECRET_RG_EXCLUDES).toContain("!secrets");
    expect(GUEST_SECRET_RG_EXCLUDES.every((g) => g.startsWith("!"))).toBe(true);
  });
});

describe("a guest's direct read of a nested secret is refused (ATO-2703)", () => {
  const work = mkdtempSync(join(tmpdir(), "guest-secret-"));
  const home = mkdtempSync(join(tmpdir(), "guest-secret-home-"));
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const guest = { guest: true, workingDir: work };

  it("refuses a key, a credentials file and a file under secrets/, and still allows source", () => {
    for (const path of ["deploy/server.pem", "config/credentials.json", "secrets/token.txt", "app/.env.local"]) {
      expect(checkGuestRead("os.fs.read", { path }, guest, { home }), path).not.toBeNull();
    }
    expect(checkGuestRead("os.fs.read", { path: "src/index.ts" }, guest, { home })).toBeNull();
    // The owner is never checked here.
    expect(checkGuestRead("os.fs.read", { path: "deploy/server.pem" }, { workingDir: work }, { home })).toBeNull();
  });
});
