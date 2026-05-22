/**
 * LoCoMo dataset loader + types.
 *
 * Source: https://github.com/snap-research/locomo  (the canonical
 * `locomo10.json` shipped on the repo, ~10 long conversations × ~50
 * sessions × hundreds of QA pairs per conversation).
 *
 * The dataset is **not** shipped with the agent — it is ~30 MB JSON
 * with non-commercial research licensing. Operators are expected to
 * download it once into `eval-memory/datasets/locomo/locomo10.json`
 * and the runner picks it up from there. The `.gitignore` next to
 * this file already excludes the dataset directory.
 *
 * Schema notes (matches the public `locomo10.json`):
 *
 *  - Each top-level entry is one long conversation. `sample_id` is
 *    the stable ID; `conversation` holds the per-session turns with
 *    `session_N` arrays of `{speaker, text, ...}` plus paired
 *    `session_N_date_time` keys for temporal grounding. `qa` is the
 *    evaluation set with a `category` integer (1..5) we map to the
 *    public LoCoMo taxonomy:
 *
 *      1 — single-hop      (one session contains the answer)
 *      2 — multi-hop       (needs evidence from ≥ 2 sessions)
 *      3 — temporal        (asks "when" / "how long" / ordering)
 *      4 — open-domain     (asks for world-knowledge fusion)
 *      5 — adversarial     (the gold answer is "I don't know")
 *
 *  - `evidence` is an opaque list of session-turn pointers used in
 *    the LoCoMo paper for recall@k computation; we surface it as-is
 *    so a future scorer can use it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const LOCOMO_DEFAULT_PATH = resolve(
  REPO_ROOT,
  "eval-memory",
  "datasets",
  "locomo",
  "locomo10.json",
);

export const LOCOMO_CATEGORY_LABELS = {
  1: "single_hop",
  2: "multi_hop",
  3: "temporal",
  4: "open_domain",
  5: "adversarial",
} as const;

export type LocomoCategoryId = keyof typeof LOCOMO_CATEGORY_LABELS;
export type LocomoCategoryLabel =
  (typeof LOCOMO_CATEGORY_LABELS)[LocomoCategoryId];

export interface LocomoTurn {
  speaker: string;
  text: string;
  /** Some entries carry image captions; we keep them but do not render. */
  blip_caption?: string;
}

export interface LocomoConversation {
  sampleId: string;
  speakerA: string;
  speakerB: string;
  /** Ordered sessions, `session_1` first. */
  sessions: Array<{
    id: string;
    dateTime: string | null;
    turns: LocomoTurn[];
  }>;
  qa: LocomoQuestion[];
}

export interface LocomoQuestion {
  question: string;
  answer: string;
  category: LocomoCategoryId;
  categoryLabel: LocomoCategoryLabel;
  evidence: string[];
  /**
   * Adversarial gold answer: when present, the LoCoMo paper grades
   * "I don't know" / abstention as correct. We surface it so the
   * runner can drive the abstention metric.
   */
  adversarialAnswer: string | null;
}

export class LocomoDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocomoDatasetError";
  }
}

interface RawConversation {
  sample_id?: string;
  conversation?: Record<string, unknown>;
  qa?: Array<Record<string, unknown>>;
}

/**
 * Load + normalise the `locomo10.json` dataset. Throws
 * `LocomoDatasetError` when the file is missing, malformed, or has
 * zero conversations.
 *
 * Path resolution:
 *  - `opts.path` override
 *  - `ATOMIC_AGENT_LOCOMO_PATH` env (operator override)
 *  - `LOCOMO_DEFAULT_PATH`
 */
export function loadLocomoDataset(opts: { path?: string } = {}): LocomoConversation[] {
  const path =
    opts.path ?? process.env.ATOMIC_AGENT_LOCOMO_PATH ?? LOCOMO_DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new LocomoDatasetError(
      `LoCoMo dataset not found at ${path}. Download locomo10.json from ` +
        `https://github.com/snap-research/locomo and place it at the default ` +
        `path, or set ATOMIC_AGENT_LOCOMO_PATH to point elsewhere.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LocomoDatasetError(`failed to parse ${path}: ${msg}`);
  }
  if (!Array.isArray(raw)) {
    throw new LocomoDatasetError(
      `${path}: expected a top-level JSON array of conversations`,
    );
  }
  const out: LocomoConversation[] = [];
  for (const entry of raw as RawConversation[]) {
    const conv = normaliseConversation(entry);
    if (conv) out.push(conv);
  }
  if (out.length === 0) {
    throw new LocomoDatasetError(
      `${path}: zero valid conversations after parsing`,
    );
  }
  return out;
}

function normaliseConversation(raw: RawConversation): LocomoConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const sampleId = typeof raw.sample_id === "string" ? raw.sample_id : null;
  const conv = raw.conversation && typeof raw.conversation === "object"
    ? (raw.conversation as Record<string, unknown>)
    : null;
  if (!sampleId || !conv) return null;

  const speakerA = typeof conv.speaker_a === "string" ? conv.speaker_a : "A";
  const speakerB = typeof conv.speaker_b === "string" ? conv.speaker_b : "B";

  const sessions: LocomoConversation["sessions"] = [];
  const sessionKeys = Object.keys(conv)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => {
      const ai = Number(a.slice("session_".length));
      const bi = Number(b.slice("session_".length));
      return ai - bi;
    });
  for (const key of sessionKeys) {
    const turnsRaw = conv[key];
    if (!Array.isArray(turnsRaw)) continue;
    const dateKey = `${key}_date_time`;
    const dateTime = typeof conv[dateKey] === "string" ? (conv[dateKey] as string) : null;
    const turns: LocomoTurn[] = [];
    for (const tRaw of turnsRaw as Array<Record<string, unknown>>) {
      if (!tRaw || typeof tRaw !== "object") continue;
      const speaker = typeof tRaw.speaker === "string" ? tRaw.speaker : "";
      const text = typeof tRaw.text === "string" ? tRaw.text : "";
      if (!speaker || !text) continue;
      const blipCaption = typeof tRaw.blip_caption === "string" ? tRaw.blip_caption : undefined;
      turns.push({
        speaker,
        text,
        ...(blipCaption ? { blip_caption: blipCaption } : {}),
      });
    }
    sessions.push({ id: key, dateTime, turns });
  }

  const qa: LocomoQuestion[] = [];
  const qaRaw = Array.isArray(raw.qa) ? raw.qa : [];
  for (const q of qaRaw) {
    const question = typeof q.question === "string" ? q.question : null;
    const answer = typeof q.answer === "string" ? q.answer : null;
    const category = normaliseCategory(q.category);
    if (!question || !answer || !category) continue;
    const evidence = Array.isArray(q.evidence)
      ? (q.evidence as unknown[]).filter((e): e is string => typeof e === "string")
      : [];
    const adversarialAnswer =
      typeof q.adversarial_answer === "string" ? q.adversarial_answer : null;
    qa.push({
      question,
      answer,
      category,
      categoryLabel: LOCOMO_CATEGORY_LABELS[category],
      evidence,
      adversarialAnswer,
    });
  }

  if (sessions.length === 0 || qa.length === 0) return null;
  return { sampleId, speakerA, speakerB, sessions, qa };
}

function normaliseCategory(raw: unknown): LocomoCategoryId | null {
  if (typeof raw === "number" && raw in LOCOMO_CATEGORY_LABELS) {
    return raw as LocomoCategoryId;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (!Number.isNaN(n) && n in LOCOMO_CATEGORY_LABELS) {
      return n as LocomoCategoryId;
    }
  }
  return null;
}

/**
 * Render one conversation as a list of user-facing prompts the agent
 * can be fed turn-by-turn before the QA phase. Each session becomes
 * **one prompt** (the operator's "I'm telling you a story") so the
 * agent's memory layer has a chance to extract durable facts
 * per session — this matches how LoCoMo's authors describe their
 * "long conversation" setup.
 *
 * The format intentionally interleaves both speakers in the message
 * body so the agent sees the original dialogue verbatim. The session
 * date-time (when known) becomes a leading marker so temporal-
 * reasoning questions have something to anchor on.
 */
export function renderConversationPrompts(conv: LocomoConversation): string[] {
  return conv.sessions.map((s) => {
    const lines: string[] = [];
    if (s.dateTime) lines.push(`[${s.id} — ${s.dateTime}]`);
    else lines.push(`[${s.id}]`);
    for (const t of s.turns) {
      lines.push(`${t.speaker}: ${t.text}`);
    }
    lines.push(
      "Remember this conversation as background context. Reply with 'OK' " +
        "and store anything noteworthy.",
    );
    return lines.join("\n");
  });
}
