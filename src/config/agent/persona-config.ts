import { ConfigValidationError } from "../config-validation-error.js";

/**
 * `agent.personas` (ATO-54): named instruction sets the user writes once
 * and switches between. A persona adds a `### persona` block to the
 * stable prefix (`src/prompt/persona-block.ts`); it never replaces the
 * built-in system text, so the tool-call mandate and the rules stay.
 *
 * ```json
 * "agent": {
 *   "personas": {
 *     "active": "reviewer",
 *     "projects": { "/work/site": "writer" },
 *     "definitions": {
 *       "reviewer": { "instructions": "Review code for bugs first.", "style": "Terse." },
 *       "writer": { "instructions": "Write plain English docs." }
 *     }
 *   }
 * }
 * ```
 *
 * The whole block is optional and absent from the shipped defaults, so a
 * file without it parses exactly as before. `active` and the project
 * bindings name a persona; a name with no definition is not an error
 * here (the definition may be added later) and simply resolves to no
 * persona, see `persona-resolve.ts`.
 */
export interface PersonaDefinition {
  /** What the agent should do differently under this persona. */
  instructions: string;
  /** Optional tone / format note, rendered on its own line. */
  style?: string;
}

export interface PersonasConfig {
  /** Persona used when no project binding matches. Absent: none. */
  active?: string;
  /** Working directory -> persona name. The closest ancestor wins. */
  projects: Record<string, string>;
  definitions: Record<string, PersonaDefinition>;
}

/**
 * The name that means "no persona" in `active`, a binding, the env
 * override and `/persona use`. Reserved: it cannot be defined.
 */
export const NO_PERSONA = "default";

/** Letters, digits, `-` and `_`; short enough to type in a command. */
export const PERSONA_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

/**
 * Upper bound for `instructions` and `style`. They live in the stable
 * prefix and are paid for on every step, so a pasted essay is refused
 * with a clear message rather than silently eating the context window.
 */
export const PERSONA_TEXT_MAX_CHARS = 8_000;

export function isValidPersonaName(name: string): boolean {
  return PERSONA_NAME_PATTERN.test(name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseName(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !isValidPersonaName(raw.trim())) {
    throw new ConfigValidationError(
      field,
      `expected a persona name (letters, digits, - or _), got ${JSON.stringify(raw)}`,
    );
  }
  return raw.trim();
}

function parseText(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ConfigValidationError(field, "expected non-empty text");
  }
  const text = raw.trim();
  if (text.length > PERSONA_TEXT_MAX_CHARS) {
    throw new ConfigValidationError(
      field,
      `expected at most ${PERSONA_TEXT_MAX_CHARS} characters, got ${text.length}`,
    );
  }
  return text;
}

function parseDefinition(raw: unknown, field: string): PersonaDefinition {
  if (!isPlainObject(raw)) throw new ConfigValidationError(field, "expected an object");
  const instructions = parseText(raw.instructions, `${field}.instructions`);
  if (raw.style === undefined || raw.style === null) return { instructions };
  return { instructions, style: parseText(raw.style, `${field}.style`) };
}

export function parsePersonasConfig(raw: unknown): PersonasConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError("agent.personas", "expected an object");
  }
  const definitions: Record<string, PersonaDefinition> = {};
  const rawDefinitions = raw.definitions ?? {};
  if (!isPlainObject(rawDefinitions)) {
    throw new ConfigValidationError("agent.personas.definitions", "expected an object");
  }
  for (const [key, value] of Object.entries(rawDefinitions)) {
    const field = `agent.personas.definitions.${key}`;
    const name = parseName(key, field);
    if (name === NO_PERSONA) {
      throw new ConfigValidationError(field, `"${NO_PERSONA}" is reserved for "no persona"`);
    }
    definitions[name] = parseDefinition(value, field);
  }
  const projects: Record<string, string> = {};
  const rawProjects = raw.projects ?? {};
  if (!isPlainObject(rawProjects)) {
    throw new ConfigValidationError("agent.personas.projects", "expected an object");
  }
  for (const [dir, value] of Object.entries(rawProjects)) {
    if (dir.trim().length === 0 || dir === "__proto__") {
      throw new ConfigValidationError("agent.personas.projects", "expected a non-empty folder path");
    }
    projects[dir] = parseName(value, `agent.personas.projects.${dir}`);
  }
  const result: PersonasConfig = { projects, definitions };
  if (raw.active !== undefined && raw.active !== null) {
    result.active = parseName(raw.active, "agent.personas.active");
  }
  return result;
}
