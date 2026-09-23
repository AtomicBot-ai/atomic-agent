import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("GET /api/capabilities", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
    delete process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET;
  });

  it("reports the LIVE approval level, not the boot snapshot", async () => {
    // The harness boots at level 5 while the persisted config default
    // is 1. A frozen `runtime.config` snapshot would report the config
    // value; the route must report the gate.
    harness = await startTestHarness({ approvalLevel: 5 });

    const before = await fetchCapabilities(harness.baseUrl);
    expect(before.agent.approvalLevel).toBe(5);

    harness.runtime.setApprovalLevel(2);
    const after = await fetchCapabilities(harness.baseUrl);
    expect(after.agent.approvalLevel).toBe(2);

    harness.runtime.setApprovalLevel(5);
    const reverted = await fetchCapabilities(harness.baseUrl);
    expect(reverted.agent.approvalLevel).toBe(5);
  });

  it("derives the compatibility approvalRequired flag from the level", async () => {
    // Clients written against the binary toggle keep working: `true`
    // while any category still prompts (level < 5), `false` only at 5.
    harness = await startTestHarness({ approvalLevel: 5 });

    expect(
      (await fetchCapabilities(harness.baseUrl)).agent.approvalRequired,
    ).toBe(false);
    harness.runtime.setApprovalLevel(4);
    expect(
      (await fetchCapabilities(harness.baseUrl)).agent.approvalRequired,
    ).toBe(true);
    harness.runtime.setApprovalLevel(1);
    expect(
      (await fetchCapabilities(harness.baseUrl)).agent.approvalRequired,
    ).toBe(true);
  });
});

/**
 * Issue #466's other half. PR #471 made the PROMPT admit how many
 * installed skills `skills.catalogTokenBudget` cut; this payload still
 * shipped the clipped array with nothing beside it, so a dashboard
 * counting `skills.length` printed the truncated number as the install.
 */
describe("GET /api/capabilities skill truncation", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
    delete process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET;
  });

  it("reports how many installed skills the catalog budget left out", async () => {
    // 4 tokens x 8 chars/token is below one rendered entry, so the
    // catalog collapses to the single always-kept row and everything
    // the starter seed installed lands in the dropped count.
    process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET = "4";
    harness = await startTestHarness();

    const installed = harness.runtime.skillRegistry.list().length;
    expect(installed).toBeGreaterThan(1);
    const body = await fetchSkills(harness.baseUrl);
    expect(body.skills).toHaveLength(1);
    expect(body.skillsOmitted).toBe(installed - 1);
    expect(body.skills.length + body.skillsOmitted).toBe(installed);
  });

  it("tracks a live registry change rather than the boot snapshot", async () => {
    process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET = "4";
    harness = await startTestHarness();
    const before = (await fetchSkills(harness.baseUrl)).skillsOmitted;

    mkdirSync(join(harness.workingDir, ".atomic-agent", "skills", "late"), {
      recursive: true,
    });
    writeFileSync(
      join(harness.workingDir, ".atomic-agent", "skills", "late", "SKILL.md"),
      [
        "---",
        "name: late",
        'description: "d"',
        "version: 0.1.0",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    await harness.runtime.refreshSkills();

    expect((await fetchSkills(harness.baseUrl)).skillsOmitted).toBe(before + 1);
  });

  it("reports 0 — and leaves the skills array untouched — when nothing was dropped", async () => {
    // Regression pin: at the shipped budget the payload's `skills`
    // array is exactly what it was before this field existed.
    harness = await startTestHarness();

    const body = await fetchSkills(harness.baseUrl);
    expect(body.skillsOmitted).toBe(0);
    expect(body.skills.map((s) => s.name)).toEqual(
      harness.runtime.skillCatalog.map((s) => s.name),
    );
    expect(body.skills).toHaveLength(
      harness.runtime.skillRegistry.list().length,
    );
  });
});

interface SkillsPayload {
  skills: Array<{ name: string; description: string; source: string }>;
  skillsOmitted: number;
}

async function fetchSkills(baseUrl: string): Promise<SkillsPayload> {
  const res = await fetch(`${baseUrl}/api/capabilities`);
  expect(res.status).toBe(200);
  return (await res.json()) as SkillsPayload;
}

async function fetchCapabilities(
  baseUrl: string,
): Promise<{ agent: { approvalLevel: number; approvalRequired: boolean } }> {
  const res = await fetch(`${baseUrl}/api/capabilities`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    agent: { approvalLevel: number; approvalRequired: boolean };
  };
}
