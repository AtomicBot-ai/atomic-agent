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
import { nameGroundingIn } from "./reflection/reflection-grounding.js";

/** One user message or closing reply, as `SessionStore.listChatLines` returns it. */
export interface ChatLine {
  kind: "user" | "assistant_reply";
  text: string;
}

/**
 * The texts of one conversation that may vouch for a name the user
 * gave: every user message, never the assistant's words.
 */
export function groundingTextsOf(lines: readonly ChatLine[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind === "user") out.push(line.text);
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
  let unverifiable = false;
  for await (const conversation of source()) {
    const verdict = nameGroundingIn(value, conversation.texts);
    if (verdict === "grounded") return "grounded";
    if (verdict === "unverifiable") unverifiable = true;
  }
  return unverifiable ? "unverifiable" : "ungrounded";
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
    verdict: "ungrounded" as NameGroundingStatus,
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
      if (item.verdict === "grounded") continue;
      if (item.checkedAt !== null && conversation.updatedAt <= item.checkedAt) {
        continue;
      }
      const verdict = nameGroundingIn(item.fact.value, conversation.texts);
      if (verdict !== "ungrounded") item.verdict = verdict;
    }
    if (open.every((item) => item.verdict === "grounded")) break;
  }
  for (const item of open) {
    // Only over a verdict nothing else gave while the walk ran: a name
    // `memory.profile.set` or reflection confirmed in the meantime keeps
    // that. A re-checked `ungrounded` fact still ungrounded only moves
    // its check time forward.
    if (
      !args.store.markNameGrounding(item.fact.id, item.verdict, startedAt, {
        ifUnconfirmed: true,
      })
    ) {
      continue;
    }
    report.checked += 1;
    report[item.verdict] += 1;
  }
  args.logger?.info("profile name facts checked against the user's messages", {
    checked: report.checked,
    grounded: report.grounded,
    ungrounded: report.ungrounded,
    unverifiable: report.unverifiable,
  });
  return report;
}
