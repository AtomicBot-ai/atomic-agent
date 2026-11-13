import { isAbsolute, relative, resolve, sep } from "node:path";

import { NO_PERSONA, type PersonaDefinition, type PersonasConfig } from "./persona-config.js";

/** Where the chosen name came from, highest precedence first. */
export type PersonaSource = "env" | "project" | "active" | "none";

export interface ResolvedPersona extends PersonaDefinition {
  name: string;
}

export interface PersonaResolution {
  /** The persona to render, or absent for the built-in behaviour. */
  persona?: ResolvedPersona;
  source: PersonaSource;
  /** The name that was asked for, when one was (including unknown ones). */
  requested?: string;
  /** True when `requested` has no definition, so nothing is rendered. */
  unknown?: boolean;
  /** The bound folder that matched, for `source: "project"`. */
  projectDir?: string;
}

/**
 * The binding for `workingDir`: an exact folder match, or else the
 * closest bound ancestor, so a session started in `repo/src` still uses
 * the persona bound to `repo`. Paths are compared after `resolve`; on
 * Windows and macOS the comparison is case-insensitive like the file
 * systems there usually are.
 */
export function findProjectBinding(
  projects: Readonly<Record<string, string>>,
  workingDir: string,
  platform: NodeJS.Platform = process.platform,
): { dir: string; name: string } | undefined {
  const fold = platform === "win32" || platform === "darwin"
    ? (p: string) => p.toLowerCase()
    : (p: string) => p;
  const target = fold(resolve(workingDir));
  let best: { dir: string; name: string; depth: number } | undefined;
  for (const [dir, name] of Object.entries(projects)) {
    const bound = fold(resolve(dir));
    const rel = relative(bound, target);
    const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) continue;
    const depth = bound.length;
    if (best === undefined || depth > best.depth) best = { dir, name, depth };
  }
  return best ? { dir: best.dir, name: best.name } : undefined;
}

/**
 * Pick the persona for a session started in `workingDir`.
 *
 * Precedence: the `ATOMIC_AGENT_PERSONA` env override, then the project
 * binding, then `agent.personas.active`. `default` at any level means
 * "no persona" and stops the search, so an env `default` turns a bound
 * persona off for one run. A name with no definition resolves to no
 * persona and is reported as `unknown` so the caller can say so.
 */
export function resolvePersona(
  personas: PersonasConfig | undefined,
  workingDir: string,
  envOverride?: string,
  platform: NodeJS.Platform = process.platform,
): PersonaResolution {
  const override = envOverride?.trim();
  let source: PersonaSource = "none";
  let requested: string | undefined;
  let projectDir: string | undefined;
  if (override) {
    source = "env";
    requested = override;
  } else if (personas) {
    const binding = findProjectBinding(personas.projects, workingDir, platform);
    if (binding) {
      source = "project";
      requested = binding.name;
      projectDir = binding.dir;
    } else if (personas.active) {
      source = "active";
      requested = personas.active;
    }
  }
  if (requested === undefined) return { source: "none" };
  const base = { source, requested, ...(projectDir !== undefined ? { projectDir } : {}) };
  if (requested === NO_PERSONA) return base;
  const definition =
    personas && Object.hasOwn(personas.definitions, requested)
      ? personas.definitions[requested]
      : undefined;
  if (!definition) return { ...base, unknown: true };
  return { ...base, persona: { name: requested, ...definition } };
}
