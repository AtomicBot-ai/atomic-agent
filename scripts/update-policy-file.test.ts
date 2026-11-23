import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseUpdatePolicy, requiredUpdateReason } from "../src/update/update-policy.js";

const ROOT = join(import.meta.dirname, "..");
const raw = readFileSync(join(ROOT, "packaging", "update-policy.json"), "utf8");
// What release.yml writes into the release body: the file as one compact JSON line.
const body = `<!-- atomic-agent-update-policy: ${JSON.stringify(JSON.parse(raw))} -->\n\n## What's Changed`;

describe("packaging/update-policy.json (ATO-1007)", () => {
  const policy = parseUpdatePolicy(body);

  it("reads back through the parser the app uses, every entry kept", () => {
    const listed = (JSON.parse(raw) as { broken: string[] }).broken;
    expect(policy.broken).toEqual(listed);
    expect(policy.minimum).toBeNull();
  });

  it("marks every 0.3.x and 0.5.x release as broken and nothing else", () => {
    for (const v of ["0.3.0", "0.3.2", "0.3.7", "0.5.0", "0.5.6"]) {
      expect(requiredUpdateReason(v, "0.8.0", policy), v).toBe("broken");
    }
    for (const v of ["0.4.2", "0.6.13", "0.7.0"]) {
      expect(requiredUpdateReason(v, "0.8.0", policy), v).toBeNull();
    }
  });

  it("is written into every new release by release.yml", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("packaging/update-policy.json");
    expect(workflow).toContain("atomic-agent-update-policy:");
  });
});
