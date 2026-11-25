/**
 * ATO-1623. Prompt for reading a chunk of the person's old chat messages
 * (from a ChatGPT or Claude export) and listing durable facts about
 * them. Same output language as reflection (`SET key=value` / `NOTE
 * body` / `NONE`, see reflection-grammar.ts) so the reflection parser
 * and grounding filter are reused as they are; only the instructions
 * differ: there is no assistant reply, many chats, and the facts go to a
 * checklist the person approves, not straight into memory.
 */

/** Fixed preamble; kept constant so a local slot can cache it across chunks. */
export const IMPORT_FACTS_STABLE_PREFIX = `You read messages a person wrote to another AI assistant in the past and list durable facts about that person.
Only the person's own messages are given. They come from many different chats and may be in any language.

Two output channels:
- SET key=value    a stable attribute of the person: name, job or role, city or country, languages, time zone, family, long-running projects, tools they use, clear preferences about how answers should look. Short snake_case keys, for example name, job, city, language, answer_style.
- NOTE body        a longer durable observation that does not fit one key (an ongoing project and its goal, a recurring interest, a habit). Third person: "The person ...".

Rules:
- Only what the person states about themselves. Never guess, never infer an age, gender, health, religion, politics, income or anything sensitive they did not plainly state about themselves.
- Skip one-off tasks ("translate this", "write a poem"), questions about the world, role-play, and text the person pasted from elsewhere.
- Never output passwords, keys, tokens, card or account numbers, addresses of a home, phone numbers or e-mail addresses, even if they appear.
- A "### known profile" block, when present, lists facts already stored; do not repeat them.
- Keep each SET value under 200 characters and each NOTE under 500.
- If there is nothing durable, output exactly: NONE
- Otherwise output up to six lines; each line is "SET key=value" or "NOTE body".
`;

export interface ImportFactsPromptInput {
  /** The person's messages for this chunk, oldest-first or newest-first, as given. */
  messages: readonly string[];
  /** Already-stored profile facts, `key=value`, at most a few dozen. */
  knownProfile?: readonly { key: string; value: string }[];
}

/** Cap of known profile facts rendered into the prompt. */
export const IMPORT_FACTS_KNOWN_PROFILE_MAX = 40;

export function buildImportFactsPrompt(input: ImportFactsPromptInput): string {
  const parts: string[] = [IMPORT_FACTS_STABLE_PREFIX];
  const known = (input.knownProfile ?? []).slice(0, IMPORT_FACTS_KNOWN_PROFILE_MAX);
  if (known.length > 0) {
    parts.push("### known profile");
    for (const f of known) parts.push(`${f.key}=${f.value.slice(0, 80)}`);
    parts.push("");
  }
  parts.push("### messages");
  input.messages.forEach((text, i) => {
    parts.push(`[${i + 1}] ${text.replace(/\r?\n+/g, " ")}`);
  });
  parts.push("", "### output");
  return parts.join("\n");
}
