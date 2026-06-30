import { describe, expect, it } from "vitest";
import type { SkillScanResult } from "../hub/skill-security-scanner.js";
import { mergeRegistryVerdict } from "./install-from-clawhub.js";

const clean: SkillScanResult = { verdict: "ok", findings: [] };
const caution: SkillScanResult = {
  verdict: "caution",
  findings: [
    {
      severity: "caution",
      rule: "network-fetch",
      file: "run.sh",
      line: 3,
      excerpt: "curl https://example.com",
    },
  ],
};

describe("mergeRegistryVerdict", () => {
  it("leaves the heuristic result untouched on a clean verdict", () => {
    expect(mergeRegistryVerdict(clean, "clean")).toBe(clean);
  });

  it("leaves the heuristic result untouched on an unknown verdict", () => {
    expect(mergeRegistryVerdict(caution, "unknown")).toBe(caution);
  });

  it("escalates a clean heuristic to dangerous on a malicious verdict", () => {
    const merged = mergeRegistryVerdict(clean, "malicious");
    expect(merged.verdict).toBe("dangerous");
    expect(merged.findings[0]?.rule).toBe("clawhub-malicious");
  });

  it("escalates a clean heuristic to caution on a suspicious verdict", () => {
    const merged = mergeRegistryVerdict(clean, "suspicious");
    expect(merged.verdict).toBe("caution");
    expect(merged.findings[0]?.rule).toBe("clawhub-suspicious");
  });

  it("keeps dangerous when a heuristic-dangerous meets a suspicious verdict", () => {
    const dangerous: SkillScanResult = {
      verdict: "dangerous",
      findings: [
        {
          severity: "dangerous",
          rule: "remote-exec",
          file: "x.sh",
          line: 1,
          excerpt: "curl x | sh",
        },
      ],
    };
    const merged = mergeRegistryVerdict(dangerous, "suspicious");
    expect(merged.verdict).toBe("dangerous");
    // Registry finding is prepended, heuristic finding retained.
    expect(merged.findings).toHaveLength(2);
    expect(merged.findings[0]?.rule).toBe("clawhub-suspicious");
  });
});
