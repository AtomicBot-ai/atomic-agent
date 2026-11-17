import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// desktop.yml's checksums job (ATO-1035): the signed SHA256SUMS.txt for the desktop release.
interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}
interface Job {
  needs?: string[];
  permissions?: Record<string, string>;
  steps: Step[];
}
const jobs = (
  parse(readFileSync(new URL("../.github/workflows/desktop.yml", import.meta.url), "utf8")) as {
    jobs: Record<string, Job>;
  }
).jobs;
const checksums = jobs.checksums!;

describe("desktop.yml checksums job", () => {
  it("waits for every job that uploads installers", () => {
    const packaging = Object.entries(jobs)
      .filter(([, job]) =>
        job.steps.some((s) => s.uses?.startsWith("actions/upload-artifact") && String(s.with?.name).startsWith("desktop-")),
      )
      .map(([id]) => id)
      .filter((id) => id !== "checksums");
    expect([...(checksums.needs ?? [])].sort()).toEqual(packaging.sort());
  });

  it("downloads one folder per artifact, since both Windows jobs write a stable.yml", () => {
    const download = checksums.steps.find((s) => s.uses?.startsWith("actions/download-artifact"));
    expect(download?.with?.["merge-multiple"]).toBeUndefined();
  });

  it("signs with the key in packaging/atomic-chat.asc and checks the signature against it", () => {
    const sign = checksums.steps.find((s) => s.name?.startsWith("Sign SHA256SUMS.txt"));
    expect(sign?.run).toContain("packaging/atomic-chat.asc");
    expect(sign?.run).toContain("gpgv --keyring");
  });

  it("attests the installers with the OIDC token it is given", () => {
    expect(checksums.steps.some((s) => s.uses?.startsWith("actions/attest-build-provenance"))).toBe(true);
    expect(checksums.permissions).toMatchObject({ "id-token": "write", attestations: "write" });
  });
});
