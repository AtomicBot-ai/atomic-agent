import { describe, expect, it } from "vitest";
import { builtinAgentProfileSet, type AgentProfileSet } from "../../agent-profiles/index.js";
import type { AgentProfile } from "../../agent-profiles/index.js";
import type { DelegateTask } from "./delegate-args.js";
import { applyTaskProfiles } from "./task-profiles.js";
import { isWorkerVisibleTool, workerToolFilterFor } from "./worker-tool-policy.js";
import { renderWorkerBrief } from "./worker-prompt.js";

const ALLOWED = [
  { providerId: "local", model: "qwen-worker" },
  { providerId: "cloud-review", model: "big-reviewer" },
];

function task(over: Partial<DelegateTask> = {}): DelegateTask {
  return { id: "t1", title: "t1", instructions: "do it", ...over };
}

function setWith(...extra: AgentProfile[]): AgentProfileSet {
  const base = builtinAgentProfileSet();
  const all = new Map(base.profiles.map((p) => [p.name, p]));
  for (const p of extra) all.set(p.name, p);
  return { profiles: [...all.values()], get: (n) => all.get(n.toLowerCase()), diagnostics: [], withheld: [] };
}

describe("applyTaskProfiles (ATO-566)", () => {
  it("leaves tasks without a profile untouched", () => {
    const tasks = [task()];
    const out = applyTaskProfiles(tasks, builtinAgentProfileSet(), ALLOWED);
    expect(out).toEqual({ ok: true, tasks, applied: [] });
  });

  it("refuses an unknown profile, naming the ones there are", () => {
    const out = applyTaskProfiles([task({ profile: "nope" })], builtinAgentProfileSet(), ALLOWED);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('task "t1" names profile "nope"');
    expect(out.error).toContain("`explore`");
    expect(out.error).toContain("`review`");
  });

  it("a built-in sets the role from its model, the prompt and a read-only allowlist", () => {
    const out = applyTaskProfiles([task({ profile: "Review" })], builtinAgentProfileSet(), ALLOWED);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [t] = out.tasks;
    expect(t?.role).toBe("review");
    expect(t?.agentProfile?.name).toBe("review");
    expect(t?.agentProfile?.prompt).toContain("reviewer");
    expect(t?.agentProfile?.tools).toContain("os.fs.read");
    expect(out.applied[0]).toMatchObject({ task: "t1", profile: "review", source: "builtin", model: "role review" });
  });

  it("the task's own model or role wins over the profile's", () => {
    const out = applyTaskProfiles(
      [task({ id: "a", profile: "explore", model: "big-reviewer" }), task({ id: "b", profile: "explore", role: "build" })],
      builtinAgentProfileSet(),
      ALLOWED,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.tasks[0]).toMatchObject({ model: "big-reviewer" });
    expect(out.tasks[0]?.role).toBeUndefined();
    expect(out.tasks[1]).toMatchObject({ role: "build" });
  });

  it("a configured model name becomes the task's model; inherit and foreign names change nothing", () => {
    const profile = (name: string, model: string): AgentProfile => ({ name, description: "", prompt: "P", model, source: "user" });
    const out = applyTaskProfiles(
      [task({ id: "a", profile: "known" }), task({ id: "b", profile: "inherits" }), task({ id: "c", profile: "claude" })],
      setWith(profile("known", "big-reviewer"), profile("inherits", "inherit"), profile("claude", "sonnet")),
      ALLOWED,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.tasks[0]?.model).toBe("big-reviewer");
    expect(out.tasks[1]?.model).toBeUndefined();
    expect(out.tasks[1]?.role).toBeUndefined();
    expect(out.tasks[2]?.model).toBeUndefined();
    expect(out.applied[2]?.notes?.[0]).toContain('profile model "sonnet" is not configured here');
  });

  it("a profile whose tools are all unknown keeps the worker's usual tools and says so", () => {
    const out = applyTaskProfiles(
      [task({ profile: "odd" })],
      setWith({ name: "odd", description: "", prompt: "P", tools: ["Teleport"], source: "user" }),
      ALLOWED,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.tasks[0]?.agentProfile?.tools).toBeUndefined();
    expect(out.applied[0]?.notes?.[0]).toContain("kept its usual tools");
  });
});

describe("workerToolFilterFor (ATO-566)", () => {
  it("without an allowlist it is the plain worker filter", () => {
    expect(workerToolFilterFor(undefined)).toBe(isWorkerVisibleTool);
  });

  it("narrows, and never brings back a tool the worker policy hides", () => {
    const filter = workerToolFilterFor(["os.fs.read", "fusion.delegate", "memory.notes.store"]);
    expect(filter("os.fs.read")).toBe(true);
    expect(filter("reply")).toBe(true);
    expect(filter("os.fs.write")).toBe(false);
    expect(filter("fusion.delegate")).toBe(false);
    expect(filter("memory.notes.store")).toBe(false);
  });
});

describe("renderWorkerBrief with a profile (ATO-566)", () => {
  it("quotes the profile's instructions before the task and names the tool limit", () => {
    const brief = renderWorkerBrief(
      task({ agentProfile: { name: "review", prompt: "REVIEW RULES", tools: ["os.fs.read"] } }),
      { workingDir: "/w" },
    );
    expect(brief).toContain("PROFILE review");
    expect(brief).toContain("REVIEW RULES");
    expect(brief).toContain("limits your tools to: os.fs.read");
    expect(brief.indexOf("REVIEW RULES")).toBeLessThan(brief.indexOf("TASK t1"));
  });

  it("is unchanged for a task without a profile", () => {
    expect(renderWorkerBrief(task(), { workingDir: "/w" })).not.toContain("PROFILE");
  });
});
