import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeUsageFile, SkillUsageLedger } from "./skill-usage-ledger.js";

describe("SkillUsageLedger", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-skill-usage-"));
    file = join(dir, "skills-usage.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts empty when the file is missing", async () => {
    expect(await new SkillUsageLedger(file).read()).toEqual({ version: 1, skills: {} });
  });

  it("counts uses and keeps the newest last-used time", async () => {
    const ledger = new SkillUsageLedger(file);
    await ledger.recordUse("alpha", 1_000);
    await ledger.recordUse("alpha", 3_000);
    await ledger.recordUse("alpha", 2_000);
    expect(await ledger.get("alpha")).toEqual({ useCount: 3, lastUsedAt: 3_000 });
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.skills.alpha.useCount).toBe(3);
  });

  it("serializes concurrent updates in one process", async () => {
    const ledger = new SkillUsageLedger(file);
    await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.recordUse("alpha", i)));
    expect((await ledger.get("alpha"))?.useCount).toBe(20);
  });

  it("records agent origin once and keeps the first creation time", async () => {
    const ledger = new SkillUsageLedger(file);
    await ledger.markAgentCreated("learned", 5_000);
    await ledger.markAgentCreated("learned", 9_000);
    await ledger.recordUse("learned", 6_000);
    expect(await ledger.get("learned")).toEqual({ useCount: 1, lastUsedAt: 6_000, origin: "agent", createdAt: 5_000 });
  });

  it("survives a corrupt file and drops broken entries", async () => {
    writeFileSync(file, "{not json", "utf8");
    expect(await new SkillUsageLedger(file).read()).toEqual({ version: 1, skills: {} });
    expect(
      normalizeUsageFile({ skills: { ok: { useCount: 2, origin: "agent" }, bad: "x", weird: { useCount: -4, origin: "hub" } } }),
    ).toEqual({ version: 1, skills: { ok: { useCount: 2, origin: "agent" }, weird: { useCount: 0 } } });
  });
});
