/**
 * ATO-2499 "Show once": one pass of the chat model over a fresh draft
 * before the person reviews it. The model names the routine, writes the
 * one-line description the agent matches requests on, says in plain words
 * what it does, and lists what to ask the user for each time (the text a
 * "type the text here" step needs). It never rewrites the steps: those stay
 * exactly as recorded (show-once-skill.ts), so a model cannot add a click
 * that nobody made.
 *
 * Sent: the apps and the step lines of the draft, as text (control names,
 * menu paths, window titles; never typed text, which was not recorded, and
 * never the pictures). Through the agent's own `POST /api/complete`
 * (agent-client.ts plainComplete), so it runs on the model the person chats
 * with. Off with the "Tidy the draft" switch on the Record card.
 *
 * Pure: the request and the answer's checks. show-once-finish.ts runs it.
 * Precedent: Claude in Chrome "teach" writes the description of a recorded
 * workflow for the person to review; Power Automate's recorder suggests
 * names for the recorded flow.
 */

export interface ShowOnceTidy {
  title: string;
  description: string;
  summary: string;
  inputs: string[];
}

export const SHOW_ONCE_TIDY_LIMITS = {
  title: 80,
  description: 280,
  summary: 600,
  inputs: 6,
  input: 100,
  /** The step text sent; /api/complete takes at most 16,000 characters. */
  prompt: 12_000,
  maxTokens: 1500,
} as const;

export const SHOW_ONCE_TIDY_SYSTEM = [
  "You turn a desktop routine a person recorded once into a reusable skill for an AI agent.",
  "Answer with one JSON object and nothing else:",
  '{"title": "...", "description": "...", "summary": "...", "inputs": ["..."]}',
  "- title: 3 to 8 words naming what the routine does, like \"Export the budget sheet as PDF\".",
  "- description: one sentence under 250 characters: what it does, then \"Use when ...\".",
  "- summary: one to three plain sentences on what the routine achieves.",
  "- inputs: what the user has to give each time, at most 6 (for example the text a \"Type the text\" step needs, a file name). Empty when nothing.",
  "Use only the apps and steps listed. Do not add, drop or change steps. Never ask for a password.",
].join("\n");

/** The user message: the apps and the numbered steps, cut to fit. */
export function showOnceTidyPrompt(apps: readonly string[], stepLines: readonly string[]): string {
  const head = `Apps: ${apps.length ? apps.join(", ") : "one Mac app"}\nSteps:\n`;
  let body = "";
  for (let i = 0; i < stepLines.length; i++) {
    const line = `${i + 1}. ${stepLines[i]}\n`;
    if (head.length + body.length + line.length > SHOW_ONCE_TIDY_LIMITS.prompt) {
      body += `(${stepLines.length - i} more steps)\n`;
      break;
    }
    body += line;
  }
  return head + body;
}

/** One line of plain text for a SKILL.md: no markup, no control characters, no front-matter breakers. */
export function tidyText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const s = raw.replace(/[\u0000-\u001f\u007f`*_#<>|[\]{}]/g, " ").replace(/^-+\s*/, "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** The model's answer, checked; null when it is not the object asked for. */
export function parseShowOnceTidy(text: unknown): ShowOnceTidy | null {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: unknown;
  try {
    o = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const L = SHOW_ONCE_TIDY_LIMITS;
  const title = tidyText(r.title, L.title);
  let description = tidyText(r.description, L.description);
  if (!title || !description) return null;
  if (!/\buse when\b/i.test(description)) {
    const more = " Use when the user asks to do this routine again.";
    if (description.length + more.length <= 300) description += more;
  }
  const summary = tidyText(r.summary, L.summary);
  const inputs = (Array.isArray(r.inputs) ? r.inputs : [])
    .map((v) => tidyText(v, L.input))
    .filter((v) => v.length > 0 && !/password|passcode|\bpin\b/i.test(v))
    .slice(0, L.inputs);
  return { title, description, summary, inputs };
}
