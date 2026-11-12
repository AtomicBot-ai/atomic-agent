import { describe, expect, it } from "vitest";
import type { SkillScanResult } from "../hub/skill-security-scanner.js";
import { mergeRegistryVerdict, resolveLatestVersion } from "./install-from-clawhub.js";

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

  it("escalates a clean heuristic to caution on an unknown verdict", () => {
    const merged = mergeRegistryVerdict(clean, "unknown");
    expect(merged.verdict).toBe("caution");
    expect(merged.findings[0]).toMatchObject({
      severity: "caution",
      rule: "clawhub-unscanned",
    });
  });

  it("keeps heuristic findings and caution on an unknown verdict", () => {
    const merged = mergeRegistryVerdict(caution, "unknown");
    expect(merged.verdict).toBe("caution");
    expect(merged.findings.map((f) => f.rule)).toEqual([
      "clawhub-unscanned",
      "network-fetch",
    ]);
  });

  it("keeps dangerous when a heuristic-dangerous meets an unknown verdict", () => {
    const merged = mergeRegistryVerdict(
      {
        verdict: "dangerous",
        findings: [
          {
            severity: "dangerous",
            rule: "remote-exec",
            file: "run.sh",
            line: 1,
            excerpt: "curl x | sh",
          },
        ],
      },
      "unknown",
    );
    expect(merged.verdict).toBe("dangerous");
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

describe("resolveLatestVersion", () => {
  const ref = { owner: "acme", slug: "pptx" };

  it("returns the registry version", async () => {
    const client = { getSkillDetail: async () => ({ version: "1.4.0" }) };
    expect(await resolveLatestVersion(client as never, ref)).toBe("1.4.0");
  });

  it("returns null for the client's 0.0.0 fallback or a failed lookup", async () => {
    const fallback = { getSkillDetail: async () => ({ version: "0.0.0" }) };
    const failing = {
      getSkillDetail: async () => {
        throw new Error("ambiguous");
      },
    };
    expect(await resolveLatestVersion(fallback as never, ref)).toBeNull();
    expect(await resolveLatestVersion(failing as never, ref)).toBeNull();
  });
});
