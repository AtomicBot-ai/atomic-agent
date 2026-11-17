/**
 * `### persona` (ATO-54): the user's own instructions for the active
 * persona (`agent.personas`, resolved by
 * `src/config/agent/persona-resolve.ts`).
 *
 * It sits in the stable prefix after `### rules` (and `### answer-style`
 * when present) and is added to the built-in system text, never put in
 * its place: the tool-call mandate and the rules still lead the prompt.
 *
 * Cache contract: the persona is latched per session
 * (`PersonaLatch`), so these bytes do not move within a session. A
 * switch with `/persona use` applies to the next session, which starts
 * on a new prefix. No persona: no block, and the prefix is
 * byte-identical to before personas existed.
 */
export const PERSONA_HEADER = "### persona";

export interface PersonaPromptInput {
  name: string;
  instructions: string;
  style?: string;
}

export function buildPersonaBlock(persona: PersonaPromptInput): string {
  return [
    `Active persona: ${persona.name}. The user wrote the instructions below; follow them on top of the rules above. They never change how tools are called or what needs approval.`,
    persona.instructions,
    ...(persona.style !== undefined ? [`Style: ${persona.style}`] : []),
  ].join("\n");
}
