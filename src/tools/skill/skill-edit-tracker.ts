import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition, ToolRegistry } from "../tool-registry.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { SkillChangeBefore, SkillChangeRecorder } from "../../skills/curator/index.js";
import { isCuratableSkillName } from "../../skills/curator/index.js";

/**
 * Agent edits of installed skills (ATO-580). The agent writes skills with
 * the ordinary file tools (the `skill-creator` starter teaches
 * `os.fs.write` into `<stateDir>/skills/<name>/`), so the history hooks
 * sit on those tools: before a call that touches a skill folder the folder
 * is copied to the skill history, and after it the change is logged as a
 * create, edit or delete by the agent. Shell commands are not tracked.
 */
export const SKILL_EDIT_TOOLS = [
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.move",
  "os.fs.trash",
  "os.fs.restore",
] as const;

/**
 * A skill folder these bring in was not written by the agent: a move
 * renames an existing (possibly hand-written) folder, a restore puts back
 * an older copy. They are logged, but the skill is not marked agent-learned.
 */
const NOT_LEARNING_TOOLS: ReadonlySet<string> = new Set(["os.fs.move", "os.fs.restore"]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** File paths in a unified diff's `---` / `+++` headers. */
function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^(?:\+\+\+|---) (?:[ab]\/)?([^\t\r\n]+)/.exec(line);
    if (m && m[1] !== "/dev/null") out.push(m[1]!.trim());
  }
  return out;
}

/** The raw path arguments a call names, before resolution. */
export function rawTargetPaths(tool: string, args: Record<string, unknown>): string[] {
  switch (tool) {
    case "os.fs.write":
    case "os.fs.edit":
    case "os.fs.restore": {
      const p = str(args.path);
      return p ? [p] : [];
    }
    case "os.fs.trash":
      return Array.isArray(args.paths) ? args.paths.map(str).filter((p): p is string => p !== null) : [];
    case "os.fs.move": {
      const out: string[] = [];
      for (const key of ["from", "to"] as const) {
        const p = str(args[key]);
        if (p) out.push(p);
      }
      if (Array.isArray(args.moves)) {
        for (const m of args.moves) {
          if (m === null || typeof m !== "object") continue;
          for (const key of ["from", "to"] as const) {
            const p = str((m as Record<string, unknown>)[key]);
            if (p) out.push(p);
          }
        }
      }
      return out;
    }
    case "os.fs.patch": {
      const patch = str(args.patch);
      return patch ? patchPaths(patch) : [];
    }
    default:
      return [];
  }
}

/** The skill folder a path falls in, or null when it is outside `skillsDir`. */
export function skillNameForPath(skillsDir: string, absPath: string): string | null {
  const rel = relative(resolve(skillsDir), resolve(absPath));
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  const first = rel.split(sep)[0] ?? "";
  return isCuratableSkillName(first) ? first : null;
}

/** Skill folder names a call would touch, deduplicated. */
export function skillTargets(
  tool: string,
  args: Record<string, unknown>,
  workingDir: string,
  skillsDir: string,
): string[] {
  let base = workingDir;
  const rootDir = tool === "os.fs.patch" ? str(args.rootDir) : null;
  if (rootDir !== null) {
    try {
      base = resolveUserPath(rootDir, workingDir);
    } catch {
      return [];
    }
  }
  const names = new Set<string>();
  for (const raw of rawTargetPaths(tool, args)) {
    let abs: string;
    try {
      abs = resolveUserPath(raw, base);
    } catch {
      continue;
    }
    const name = skillNameForPath(skillsDir, abs);
    if (name !== null) names.add(name);
  }
  return [...names];
}

export interface TrackSkillEditsOptions {
  recorder: SkillChangeRecorder;
  /** History bookkeeping never fails a tool call; failures are reported here. */
  onError?: (error: unknown, tool: string) => void;
}

const TRACKED = new WeakSet<ToolDefinition>();

/** Wrap the file tools so agent changes to skill folders are snapshotted and logged. */
export function trackSkillEdits(
  registry: Pick<ToolRegistry, "has" | "get" | "register">,
  options: TrackSkillEditsOptions,
): string[] {
  const { recorder } = options;
  const report = (err: unknown, tool: string) => options.onError?.(err, tool);
  const wrapped: string[] = [];
  for (const name of SKILL_EDIT_TOOLS) {
    if (!registry.has(name)) continue;
    const inner = registry.get(name);
    wrapped.push(name);
    if (TRACKED.has(inner)) continue;
    const definition: ToolDefinition = {
      ...inner,
      async run(args, ctx) {
        const targets = skillTargets(name, args, ctx.workingDir, recorder.skillsDir);
        if (targets.length === 0) return inner.run(args, ctx);
        const befores: SkillChangeBefore[] = [];
        for (const target of targets) {
          try {
            befores.push(await recorder.before(target));
          } catch (err) {
            report(err, name);
          }
        }
        const result = await inner.run(args, ctx);
        if (result.status === "error") return result;
        for (const before of befores) {
          try {
            await recorder.after(before, "agent", name, { learned: !NOT_LEARNING_TOOLS.has(name) });
          } catch (err) {
            report(err, name);
          }
        }
        return result;
      },
    };
    TRACKED.add(definition);
    registry.register(definition);
  }
  return wrapped;
}
