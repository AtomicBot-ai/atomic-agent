import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { inspectProjectTrust } from "../../runtime/project-trust.js";
import { ProjectTrustOrchestrator } from "./project-trust-orchestrator.js";

describe("ProjectTrustOrchestrator", () => {
  let base: string; let repo: string; let actions: Array<{ type: string; [key: string]: unknown }>; let refresh: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "tui-project-trust-"))); repo = join(base, "repo");
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(base, "state")); resetConfigCache();
    actions = []; refresh = vi.fn(async () => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(base, { recursive: true, force: true }); });

  function skill(name: string) {
    const dir = join(repo, ".agents/skills", name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
  }
  function orchestrator() {
    return new ProjectTrustOrchestrator({ config: () => getConfig(), workingDir: () => repo,
      emit: (action) => actions.push(action as { type: string }), refresh });
  }

  it("asks with counts at startup, records yes and refreshes the catalog", async () => {
    skill("alpha"); writeFileSync(join(repo, "AGENTS.md"), "RULE");
    const o = orchestrator(); o.check();
    const asked = actions.find(a => a.type === "project_trust_asked") as { prompt: { question: string } } | undefined;
    expect(asked?.prompt.question).toBe("This folder has 1 project skill and AGENTS.md. Trust them?");
    await o.answer("trust");
    expect(refresh).toHaveBeenCalledOnce();
    expect(inspectProjectTrust(getConfig(), repo).trusted).toEqual({ skills: ["alpha"], instructions: ["AGENTS.md"] });
    actions.length = 0; orchestrator().check();
    expect(actions.some(a => a.type === "project_trust_asked")).toBe(false);
  });

  it("asks nothing for a folder without project items", () => {
    mkdirSync(repo); orchestrator().check();
    expect(actions).toEqual([]);
  });

  it("asks again about the current set when the folder changed while the question was up", async () => {
    skill("alpha");
    const o = orchestrator(); o.check();
    skill("beta");
    await o.answer("trust");
    expect(refresh).not.toHaveBeenCalled();
    const asked = actions.filter(a => a.type === "project_trust_asked") as unknown as Array<{ prompt: { question: string } }>;
    expect(asked.at(-1)?.prompt.question).toBe("This folder has 2 project skills. Trust them?");
    expect(inspectProjectTrust(getConfig(), repo).trusted.skills).toEqual([]);
  });

  it("remembers no and tells the operator how to trust later", async () => {
    skill("alpha");
    const o = orchestrator(); o.check(); await o.answer("decline");
    expect(inspectProjectTrust(getConfig(), repo).declined.skills).toEqual(["alpha"]);
    expect(actions.some(a => a.type === "runtime_info" && String(a.line).includes("atomic-agent skill project on --workspace"))).toBe(true);
  });
});
