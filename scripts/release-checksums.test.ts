import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// release.yml's checksums job (ATO-1035): one signed SHA256SUMS.txt per release and a
// provenance attestation per file. These pin the wiring a later edit could quietly break: the
// draft must wait for the job, its artifact must match the draft's `release-*` download, and the
// attestation needs the OIDC token.
interface Step {
  name?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  run?: string;
}
interface Job {
  needs?: string[];
  permissions?: Record<string, string>;
  steps: Step[];
}
const jobs = (
  parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as {
    jobs: Record<string, Job>;
  }
).jobs;
const checksums = jobs.checksums!;

describe("release.yml checksums job", () => {
  it("runs after the bundles and packages, and the draft waits for it", () => {
    expect(checksums.needs).toEqual(["build", "packages"]);
    expect(jobs.release!.needs).toContain("checksums");
  });

  it("uploads under a release-* name, so the draft's merged download picks the sums up", () => {
    const upload = checksums.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(String(upload?.with?.name)).toMatch(/^release-/);
    expect(String(upload?.with?.path)).toBe("sums/SHA256SUMS.txt*");
  });

  it("signs with the key in packaging/atomic-chat.asc and checks the signature against it", () => {
    const sign = checksums.steps.find((s) => s.name?.startsWith("Sign SHA256SUMS.txt"));
    expect(sign?.run).toContain("packaging/atomic-chat.asc");
    expect(sign?.run).toContain("--detach-sign");
    expect(sign?.run).toContain("gpgv --keyring");
  });

  it("attests the release files with the OIDC token it is given", () => {
    const attest = checksums.steps.find((s) => s.uses?.startsWith("actions/attest-build-provenance"));
    expect(attest).toBeDefined();
    expect(checksums.permissions).toMatchObject({ "id-token": "write", attestations: "write" });
  });
});
