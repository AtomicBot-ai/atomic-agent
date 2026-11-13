import { resolve } from "node:path";

import { getConfig, resetConfigCache } from "./config-cache.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import type { UserConfigFile } from "./config-schema.js";
import { ConfigValidationError } from "./config-validation-error.js";
import { isValidPersonaName, NO_PERSONA, type PersonasConfig } from "./agent/persona-config.js";

/**
 * Writers behind `/persona use` and `/persona bind` (ATO-54). Each one
 * rewrites `agent.personas` in the user config file and drops the config
 * cache. A running session keeps its latched persona (`PersonaLatch`);
 * the change applies to the next session.
 */

function readPersonas(path: string): { file: UserConfigFile; personas: PersonasConfig } {
  const file = structuredClone(ensureUserConfigFileSync(path));
  const personas = file.agent.personas ?? { projects: {}, definitions: {} };
  return { file, personas };
}

function writePersonas(path: string, file: UserConfigFile, personas: PersonasConfig): void {
  const empty =
    personas.active === undefined &&
    Object.keys(personas.projects).length === 0 &&
    Object.keys(personas.definitions).length === 0;
  const agent = { ...file.agent };
  if (empty) delete agent.personas;
  else agent.personas = personas;
  writeUserConfigFileSync(path, { ...file, agent });
  resetConfigCache();
}

/** `default` clears; any other name must already be defined. */
function checkName(name: string, personas: PersonasConfig): string | null {
  const trimmed = name.trim();
  if (trimmed === NO_PERSONA) return null;
  if (!isValidPersonaName(trimmed)) {
    throw new ConfigValidationError("persona", `expected a persona name, got ${JSON.stringify(name)}`);
  }
  if (!Object.hasOwn(personas.definitions, trimmed)) {
    const known = Object.keys(personas.definitions);
    throw new ConfigValidationError(
      "persona",
      `no persona named ${JSON.stringify(trimmed)}; defined: ${known.length > 0 ? known.join(", ") : "none"}`,
    );
  }
  return trimmed;
}

/** Set `agent.personas.active`; `default` removes it. */
export function setActivePersonaInConfig(name: string): void {
  const path = getConfig().paths.userConfigFile;
  const { file, personas } = readPersonas(path);
  const chosen = checkName(name, personas);
  const next: PersonasConfig = { ...personas };
  if (chosen === null) delete next.active;
  else next.active = chosen;
  writePersonas(path, file, next);
}

/**
 * Bind `workingDir` to a persona; `default` removes the binding. The
 * folder is stored resolved, which is the form `findProjectBinding`
 * compares against.
 */
export function bindProjectPersonaInConfig(workingDir: string, name: string): string {
  const path = getConfig().paths.userConfigFile;
  const { file, personas } = readPersonas(path);
  const chosen = checkName(name, personas);
  const dir = resolve(workingDir);
  const projects = { ...personas.projects };
  if (chosen === null) delete projects[dir];
  else projects[dir] = chosen;
  writePersonas(path, file, { ...personas, projects });
  return dir;
}
