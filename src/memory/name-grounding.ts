/**
 * Checks a stored name against what the user actually wrote, across
 * every stored session (ATO-199 / ATO-200).
 *
 * The reflection filter (`reflection-grounding.ts`) only sees the
 * reflected window, and only for new writes. Two gaps remain, both
 * closed here:
 *
 *  - Names already on disk. Older builds stored names nobody typed (the
 *    field case: `name = Анна`, in none of the user's 56 sessions). On
 *    every start `verifyProfileNameFacts` checks each name-like fact not
 *    checked yet against every stored user message and records the
 *    verdict on the row (`profile_facts.name_grounding`). An
 *    `ungrounded` name stays on disk and in every listing, marked, but
 *    is never rendered into the prompt (`ProfileStore.listForPrompt`).
 *    It is re-checked on later starts against the sessions written
 *    since, so a name the user does say later is picked up.
 *  - The agent's own `memory.profile.set`, which writes whatever the
 *    model passes. It checks the name the same way before writing
 *    (`profile-set.ts`), current session first, then every stored one —
 *    so a name the user gave last week still counts.
 *
 * Grounding comes ONLY from the user's own messages. Stored profile
 * values, notes, tool output and the assistant's replies never vouch for
 * a name — an invented name would otherwise vouch for itself.
 *
 * Cost: one SQL projection per stored session (user messages and
 * closing replies only, `SessionStore.listChatLines`), one pass for all
 * pending names, stopped as soon as each is grounded. The scan yields to
 * the event loop between pages, and runs only for rows not checked yet
 * (once per row) or `ungrounded` rows (over the sessions written since).
 */

import type { StructuredLogger } from "../tracing/structured-logger.js";

import type { NameGroundingStatus } from "./profile-name-keys.js";
import type { ProfileStore } from "./profile-store.js";
import {
  countScriptLetters,
  isBareConfirmation,
  nameGroundingIn,
  namingQuestionsOf,
  type ScriptLetterCounts,
} from "./reflection/reflection-grounding.js";

/** One user message or closing reply, as `SessionStore.listChatLines` returns it. */
export interface ChatLine {
  kind: "user" | "assistant_reply";
  text: string;
}

/**
 * A live transcript (`SessionState.turns`) as chat lines: user messages
 * and closing replies, the same projection `listChatLines` makes in SQL.
 * Structural so this module needs nothing from `src/session/`.
 */
export function chatLinesOf(
  turns: readonly { kind: string; text?: unknown; progressNote?: unknown }[],
): ChatLine[] {
  const out: ChatLine[] = [];
  for (const turn of turns) {
    if (typeof turn.text !== "string") continue;
    if (turn.kind === "user") out.push({ kind: "user", text: turn.text });
    else if (turn.kind === "assistant_reply" && turn.progressNote !== true) {
      out.push({ kind: "assistant_reply", text: turn.text });
    }
  }
  return out;
}

/**
 * The texts of one conversation that may vouch for a name the user
 * gave: every user message, and — ATO-201 — the assistant's naming
 * question right before a bare "yes" ("Тебя зовут Алекс?" — "да"), the
 * one way a name gets confirmed without the user typing it. Nothing
 * else the assistant wrote ever counts: "Привет, Анна!" vouches for
 * nothing.
 */
export function groundingTextsOf(lines: readonly ChatLine[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.kind !== "user") continue;
    out.push(line.text);
    const previous = i > 0 ? lines[i - 1]! : null;
    if (previous?.kind === "assistant_reply" && isBareConfirmation(line.text)) {
      out.push(...namingQuestionsOf(previous.text));
    }
  }
  return out;
}

/** One stored conversation, as the scan sees it. */
export interface GroundingConversation {
  updatedAt: number;
  /** `groundingTextsOf` the conversation. */
  texts: readonly string[];
}

/**
 * Stored conversations, newest first. `since` stops the walk at the
 * first one not updated after it. Async so a long walk can yield.
 */
export type GroundingConversationSource = (options?: {
  since?: number;
}) => AsyncIterable<GroundingConversation>;

/** The slice of `SessionStore` the scan needs (structural, for tests). */
export interface SessionTranscriptReader {
  listSummaryPage(options: {
    limit: number;
    after?: { updatedAt: number; id: string };
  }): readonly { id: string; updatedAt: number }[];
  listChatLines(id: string): readonly ChatLine[];
}

const SCAN_PAGE_SIZE = 50;

/**
 * Walk every stored session the user has spoken to, newest first, one
 * page at a time, yielding to the event loop between pages —
 * `better-sqlite3` is synchronous, and a store with thousands of
 * sessions must not stall a boot or a turn for the whole walk.
 */
export function sessionGroundingSource(
  sessions: SessionTranscriptReader,
  pageSize: number = SCAN_PAGE_SIZE,
): GroundingConversationSource {
  return async function* walk(options) {
    let after: { updatedAt: number; id: string } | undefined;
    for (;;) {
      const page = sessions.listSummaryPage({
        limit: pageSize,
        ...(after !== undefined ? { after } : {}),
      });
      if (page.length === 0) return;
      for (const row of page) {
        if (options?.since !== undefined && row.updatedAt <= options.since) return;
        yield {
          updatedAt: row.updatedAt,
          texts: groundingTextsOf(sessions.listChatLines(row.id)),
        };
      }
      if (page.length < pageSize) return;
      const last = page[page.length - 1]!;
      after = { updatedAt: last.updatedAt, id: last.id };
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
}

/**
 * How `value` compares with every stored conversation: `grounded` as
 * soon as one carries it, otherwise `unverifiable` when some
 * conversation could not be compared, otherwise `ungrounded`.
 */
export async function nameGroundingAcrossSessions(
  value: string,
  source: GroundingConversationSource,
): Promise<NameGroundingStatus> {
  const letters: ScriptLetterCounts = { other: 0, comparable: 0 };
  for await (const conversation of source()) {
    if (groundedInConversation(value, conversation)) return "grounded";
    addLetters(letters, conversation);
  }
  return verdictOverAll(value, letters);
}

/**
 * Whether one conversation carries the name. Each conversation is
 * compared as if written in Latin / Cyrillic: whether the user writes
 * "mostly in another script" is decided once, over every conversation
 * scanned (`verdictOverAll`) — a single stored session that is mostly
 * a pasted Chinese log must not make an invented Latin name
 * unverifiable for good.
 */
function groundedInConversation(
  value: string,
  conversation: GroundingConversation,
): boolean {
  return (
    nameGroundingIn(value, conversation.texts, { letters: COMPARABLE }) === "grounded"
  );
}

const COMPARABLE: ScriptLetterCounts = { other: 0, comparable: 1 };

function addLetters(into: ScriptLetterCounts, conversation: GroundingConversation): void {
  const counts = countScriptLetters(conversation.texts);
  into.other += counts.other;
  into.comparable += counts.comparable;
}

/** The verdict for a name no conversation carried. */
function verdictOverAll(value: string, letters: ScriptLetterCounts): NameGroundingStatus {
  const verdict = nameGroundingIn(value, [], { letters });
  return verdict === "grounded" ? "ungrounded" : verdict;
}

export interface ProfileNameCheckReport {
  checked: number;
  grounded: number;
  ungrounded: number;
  unverifiable: number;
}

/**
 * Check every name-like profile fact that needs it (never checked, or
 * `ungrounded` — against the sessions written since) and record the
 * verdict on its row. One walk serves all pending facts; it ends early
 * once every one of them is grounded. Never deletes anything.
 *
 * Logs counts only — never keys or values (a name is personal data).
 */
export async function verifyProfileNameFacts(args: {
  store: ProfileStore;
  source: GroundingConversationSource;
  logger?: StructuredLogger;
  now?: () => number;
}): Promise<ProfileNameCheckReport> {
  const now = args.now ?? Date.now;
  const pending = args.store.listNameFactsToCheck();
  const report: ProfileNameCheckReport = {
    checked: 0,
    grounded: 0,
    ungrounded: 0,
    unverifiable: 0,
  };
  if (pending.length === 0) return report;
  // Taken before the walk: a session written while it runs is newer than
  // this and gets looked at by the next check.
  const startedAt = now();
  const open = pending.map((item) => ({
    ...item,
    grounded: false,
    letters: { other: 0, comparable: 0 } as ScriptLetterCounts,
  }));
  // A never-checked fact needs every session; an `ungrounded` one only
  // those written after its last check.
  const since = open.some((item) => item.checkedAt === null)
    ? undefined
    : Math.min(...open.map((item) => item.checkedAt ?? 0));
  for await (const conversation of args.source(
    since !== undefined ? { since } : {},
  )) {
    for (const item of open) {
      if (item.grounded) continue;
      if (item.checkedAt !== null && conversation.updatedAt <= item.checkedAt) {
        continue;
      }
      if (groundedInConversation(item.fact.value, conversation)) {
        item.grounded = true;
      } else {
        addLetters(item.letters, conversation);
      }
    }
    if (open.every((item) => item.grounded)) break;
  }
  for (const item of open) {
    // A re-check never turns an `ungrounded` name `unverifiable`: newer
    // sessions in another script say nothing about a name every older
    // one was compared against.
    const verdict: NameGroundingStatus = item.grounded
      ? "grounded"
      : item.checkedAt !== null
        ? "ungrounded"
        : verdictOverAll(item.fact.value, item.letters);
    // Only over a verdict nothing else gave while the walk ran: a name
    // `memory.profile.set` or reflection confirmed in the meantime keeps
    // that. A re-checked `ungrounded` fact still ungrounded only moves
    // its check time forward.
    if (
      !args.store.markNameGrounding(item.fact.id, verdict, startedAt, {
        ifUnconfirmed: true,
      })
    ) {
      continue;
    }
    report.checked += 1;
    report[verdict] += 1;
  }
  args.logger?.info("profile name facts checked against the user's messages", {
    checked: report.checked,
    grounded: report.grounded,
    ungrounded: report.ungrounded,
    unverifiable: report.unverifiable,
  });
  return report;
}
