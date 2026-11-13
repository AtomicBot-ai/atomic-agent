import { getConfig } from "../../config/index.js";
import { NO_PERSONA } from "../../config/agent/persona-config.js";
import { resolvePersona, type PersonaResolution } from "../../config/agent/persona-resolve.js";
import { bindProjectPersonaInConfig, setActivePersonaInConfig } from "../../config/persona-commands.js";
import type { TuiAction } from "../tui-action.js";

/**
 * `/persona` (ATO-54). Pure parsing here; `runPersonaCommand` is called
 * from the submit path, which owns persistence.
 *
 *   /persona                     list personas and what a new session here uses
 *   /persona use <name|default>  set the persona used everywhere without a binding
 *   /persona bind <name|default> bind (or unbind) the current folder
 */
export type PersonaCommand =
  | { kind: "list" }
  | { kind: "use"; name: string }
  | { kind: "bind"; name: string }
  | { kind: "error"; message: string };

export const PERSONA_USAGE =
  "usage: /persona | /persona use <name|default> | /persona bind <name|default>";

const NEXT_SESSION_NOTE =
  "The chat that is open keeps the persona it started with; this applies from the next session (/new).";

export function parsePersonaCommand(args: string): PersonaCommand {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0]!.toLowerCase() === "list")) {
    return { kind: "list" };
  }
  const verb = words[0]!.toLowerCase();
  if (words.length === 2 && verb === "use") return { kind: "use", name: words[1]! };
  if (words.length === 2 && verb === "bind") return { kind: "bind", name: words[1]! };
  return { kind: "error", message: PERSONA_USAGE };
}

function describeResolution(resolution: PersonaResolution): string {
  if (resolution.persona) {
    const from =
      resolution.source === "env" ? "ATOMIC_AGENT_PERSONA"
      : resolution.source === "project" ? `the binding for ${resolution.projectDir ?? "this folder"}`
      : "agent.personas.active";
    return `A new session here uses: ${resolution.persona.name} (from ${from}).`;
  }
  if (resolution.unknown) {
    return `A new session here asks for "${resolution.requested}", which is not defined, so it runs without a persona.`;
  }
  return "A new session here runs without a persona.";
}

/** The listing, given the working directory a new session would start in. */
export function formatPersonaListing(workingDir: string): string {
  const agent = getConfig().agent;
  const personas = agent.personas;
  const names = Object.keys(personas?.definitions ?? {});
  const lines: string[] = [];
  if (names.length === 0) {
    lines.push(
      "No personas defined. Add them to agent.personas.definitions in the config file, e.g.",
      `  "personas": { "definitions": { "reviewer": { "instructions": "Review for bugs first.", "style": "Terse." } } }`,
    );
  } else {
    lines.push("Personas:");
    for (const name of names) {
      const marks = [
        ...(personas?.active === name ? ["active"] : []),
        ...Object.entries(personas?.projects ?? {})
          .filter(([, bound]) => bound === name)
          .map(([dir]) => `bound: ${dir}`),
      ];
      const first = personas!.definitions[name]!.instructions.split("\n")[0] ?? "";
      const preview = first.length > 60 ? `${first.slice(0, 57)}...` : first;
      lines.push(`  ${name}${marks.length > 0 ? ` [${marks.join("; ")}]` : ""}: ${preview}`);
    }
  }
  lines.push(describeResolution(resolvePersona(personas, workingDir, agent.personaOverride)));
  return lines.join("\n");
}

/**
 * Runs a parsed command. `workingDir` is the folder `bind` applies to and
 * the one the listing resolves for: the folder the terminal agent runs in.
 */
export function runPersonaCommand(
  command: PersonaCommand,
  dispatch: (action: TuiAction) => void,
  workingDir: string = process.cwd(),
): void {
  const say = (text: string) => dispatch({ type: "system_message", text });
  try {
    switch (command.kind) {
      case "error":
        say(command.message);
        return;
      case "list":
        say(formatPersonaListing(workingDir));
        return;
      case "use":
        setActivePersonaInConfig(command.name);
        say(
          command.name === NO_PERSONA
            ? `Persona cleared. ${NEXT_SESSION_NOTE}`
            : `Persona set to ${command.name}. ${NEXT_SESSION_NOTE}`,
        );
        break;
      case "bind": {
        const dir = bindProjectPersonaInConfig(workingDir, command.name);
        say(
          command.name === NO_PERSONA
            ? `Removed the persona binding for ${dir}. ${NEXT_SESSION_NOTE}`
            : `Bound ${dir} to persona ${command.name}. ${NEXT_SESSION_NOTE}`,
        );
        break;
      }
    }
    if (getConfig().agent.personaOverride) {
      say(`Note: ATOMIC_AGENT_PERSONA=${getConfig().agent.personaOverride} is set and wins over this setting.`);
    }
  } catch (error) {
    say(`persona: ${error instanceof Error ? error.message : String(error)}`);
  }
}
