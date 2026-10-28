import { describe, expect, it } from "vitest";

import type { SkillScanResult } from "../skills/index.js";
import {
  createInstallConfirm,
  formatScanFindings,
} from "./skill-install-confirm.js";

const caution: SkillScanResult = {
  verdict: "caution",
  findings: [
    {
      severity: "caution",
      rule: "network-fetch",
      file: "run.sh",
      line: 3,
      excerpt: "curl https://api.example",
    },
  ],
};

describe("createInstallConfirm", () => {
  it("returns no prompt without a terminal, so the gate refuses", () => {
    expect(createInstallConfirm({ isTTY: () => false })).toBeUndefined();
  });

  it("shows the findings and installs on yes", async () => {
    let shown = "";
    const prompts: string[] = [];
    const confirm = createInstallConfirm({
      isTTY: () => true,
      ask: async (p) => {
        prompts.push(p);
        return " y ";
      },
      writeErr: (t) => {
        shown += t;
      },
    });
    expect(confirm).toBeDefined();
    expect(await confirm!(caution)).toBe(true);
    expect(shown).toContain("network-fetch");
    expect(shown).toContain("run.sh:3");
    expect(prompts[0]).toContain("[y/N]");
  });

  it("treats anything but yes (including Enter) as no", async () => {
    for (const answer of ["", "n", "no", "sure"]) {
      const confirm = createInstallConfirm({
        isTTY: () => true,
        ask: async () => answer,
        writeErr: () => {},
      });
      expect(await confirm!(caution)).toBe(false);
    }
  });
});

describe("formatScanFindings", () => {
  it("prints the verdict and one line per finding", () => {
    const text = formatScanFindings(caution);
    expect(text.split("\n")[0]).toBe("security scan: caution");
    expect(text).toContain("[caution] network-fetch  run.sh:3");
  });
});
