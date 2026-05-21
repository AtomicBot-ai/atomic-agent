/**
 * Micro-prompt builder for the async end-of-turn reflection call. The
 * prompt is intentionally split into two parts:
 *
 *  - a **stable prefix** that is a byte-stable module-level constant so
 *    the dedicated reflection slot on llama-server can reuse its KV
 *    cache across every call. Nothing in the prefix ever varies.
 *  - a **variable tail** that carries the trimmed last USER / ASSISTANT
 *    messages plus the `### output` marker.
 *
 * The prompt is deliberately tiny (~150 tokens of prefix + up to ~500
 * tokens of tail) so reflection stays cheap enough to run at the end of
 * every turn without affecting user-visible latency.
 */

/**
 * Hard cap on the USER / ASSISTANT excerpts injected into the tail.
 * Protects the reflection slot from blowing its KV cache on pathological
 * long replies. Characters, not tokens — tokenisation is left to the
 * server.
 */
export const REFLECTION_MESSAGE_CHAR_CAP = 1_000;

/**
 * v2.5 typed-NOTE preamble. Opt-in via
 * `memory.reflection.typedNotes.enabled` (default `false`). When the
 * config flag is on, the reflection runner picks **this** prefix
 * instead of `REFLECTION_STABLE_PREFIX`, and the model is told to tag
 * every NOTE with `[type=event|behavior|knowledge|skill]` immediately
 * after `NOTE `. The grammar already accepts the marker as an optional
 * production (`typemark?` in `reflection-grammar.ts`), so a legacy
 * untyped completion is still grammatically valid; the prompt is the
 * pressure that makes typed output canonical when the flag is on.
 *
 * Per-type forbidden lists steer the model away from category mistakes.
 * The four
 * canonical buckets keep BM25 and lesson-clustering signals clean:
 *  - `event`     one-off happening with time/location/participants
 *  - `behavior`  recurring pattern, routine, or solution
 *  - `knowledge` static factual content (concepts, definitions, lore)
 *  - `skill`     replicable how-to with concrete tools / metrics
 *
 * The prefix is a byte-stable module-level constant so it owns its
 * own KV cache slot, independent of the legacy `REFLECTION_STABLE_PREFIX`.
 * Switching between the two prefixes (by flipping the config flag)
 * invalidates the **reflection slot's** KV cache once on the next
 * call; the main agent slot is unaffected.
 */
export const REFLECTION_STABLE_PREFIX_TYPED = `You are a memory extractor for a personal assistant.
Given the last USER and ASSISTANT messages, output durable things worth remembering across sessions.

Two output channels:
- SET key=value    atomic key/value facts about the user (name, timezone, language, preferences, stated goals). Rendered into every future prompt, so keep them small and canonical.
- NOTE [type=X] body  freeform observations worth recalling later. ALWAYS prefix the body with one of [type=event], [type=behavior], [type=knowledge], or [type=skill]. Stored but NOT auto-rendered; the agent looks them up on demand.

SET has two flavours:
- Default (pinned) — the fact is always rendered into \`### profile\`. Use for truly identity-level facts that apply to most turns (name, primary language, timezone).
- Contextual — the fact is ONLY rendered when a keyword hits the current user message. Use for rare/large context (deploy commands, per-feature preferences, per-project env snippets). Emit as: SET key=value [pinned=false; keywords=a,b,c]. The [...] marker MUST be on the same line, keywords comma-separated, lowercase, 1–8 entries.

Bi-temporal versioning:
- Every SET preserves history automatically — re-writing the same key never erases the previous version. The earlier value is still available via the \`memory.profile.history\` tool.
- When the user explicitly switches a value ("actually let's use X now"), add a supersession marker so future readers can see the intent: SET key=new_value [valid_from=now; supersedes=key]. Same-key supersession (e.g. language: ru → en) makes the chain explicit; cross-key supersession (e.g. SET full_name=Alex [supersedes=name]) marks both rows in a single write.
- The valid_from token must be the literal "now"; the runtime stamps the actual timestamp.

NOTE types (pick exactly one per line):
- [type=event]      a specific happening at a particular time, with participants/location when known. Concrete activity or experience.
- [type=behavior]   a recurring pattern, routine, or established solution — how the user typically acts. NEVER use for a single one-off event.
- [type=knowledge]  static factual content the user knows or works with (concepts, definitions, domain lore). NEVER use for events or behaviors.
- [type=skill]      a replicable how-to with concrete tools, steps, and outcomes — a capability that can be applied again. NEVER use for trivial actions ("used Docker") or pure opinions.

Forbidden in every NOTE:
- Trivia, chit-chat, weather, transient moods, facts about the AI itself.
- Content introduced only by the assistant and not explicitly confirmed by the user.
- Private financial accounts, IDs, addresses, military/defense/government job details, precise street addresses — unless the user explicitly asked to remember them.

Rules:
- Only durable content explicitly stated by the user or that the user asked to remember.
- Use SET for anything that looks like a stable attribute of the user. Prefer short snake_case keys (e.g. name, timezone, trip_lisbon_plan). Keep each SET value under 200 characters.
- Prefer contextual SET when the fact is valuable only in a specific topic. If unsure, default to pinned SET.
- Use NOTE [type=X] for anything episodic, behavioural, knowledge-bearing, or skill-shaped that does not fit a single key. Keep each NOTE body under 500 characters. A NOTE may end with an optional trailing tag marker " [tags=a,b,c]" (lowercase, snake or hyphen, up to 8 tags).
- If a SET already captures the fact, do not also emit a NOTE repeating it.
- If there is nothing worth remembering, output exactly: NONE
- Otherwise output up to six lines total; each line is either "SET key=value" (optionally followed by a pinned/keywords marker) or "NOTE [type=X] body" (optionally followed by a trailing tags marker).
`;

/**
 * Multi-party / "any speaker" reflection prefix (config v19+
 * addition). Designed for evaluation benchmarks (LoCoMo,
 * LongMemEval) and any deployment where the USER message is a
 * dump of a third-party conversation transcript rather than the
 * user's own statements. Differs from the default user-centric
 * prefixes in three ways:
 *
 *  - Drops the "Only durable content explicitly stated by the
 *    user" guardrail. The default prompt aggressively rejects
 *    content "introduced only by the assistant and not explicitly
 *    confirmed by the user" — correct for a personal assistant,
 *    wrong when the USER channel carries a multi-speaker dialog
 *    that the assistant is supposed to remember on the user's
 *    behalf.
 *  - Encourages SET keys prefixed with the participant name
 *    (`caroline_career_goal`, `melanie_kids_count`) so the
 *    profile fact namespace stays clean across many tracked
 *    third parties.
 *  - Always asks for a `[type=event|behavior|knowledge|skill]`
 *    marker on every NOTE — typed-NOTE extraction is the
 *    canonical mode for this prefix, no separate "typed variant"
 *    needed.
 *
 * Selecting this prefix at runtime requires
 * `memory.reflection.anySpeaker = true` in the user config.
 * Default is `false`; flipping the flag invalidates the reflection
 * slot's KV cache once on the next call (same one-shot pattern as
 * `typedNotes`). The main agent slot is untouched.
 *
 * Pinned by [reflection-prompt.test.ts](src/memory/reflection/reflection-prompt.test.ts)
 * "any-speaker prefix is byte-stable" + the probe runs in
 * `eval-memory/scripts/probe-reflection.mjs` that confirmed
 * 8/8 NONE → 7/7 SET+NOTE on Caroline/Melanie dialog fixtures.
 */
export const REFLECTION_STABLE_PREFIX_ANY_SPEAKER = `You are a memory extractor for an assistant that helps the user track multi-party conversations.
Given the last USER and ASSISTANT messages, output durable things worth remembering across sessions about ANY participant mentioned (the user, named third parties, or shared context).

Two output channels:
- SET key=value    atomic key/value facts about ANY participant or topic (e.g. caroline_career_goal=mental_health_counseling, melanie_wedding_year=2018, current_project=adoption_research). Rendered into every future prompt, so keep them small and canonical.
- NOTE [type=X] body  freeform observations worth recalling later. ALWAYS prefix the body with one of [type=event], [type=behavior], [type=knowledge], or [type=skill]. Stored but NOT auto-rendered; looked up on demand.

NOTE types (pick exactly one per line):
- [type=event]      a specific happening at a particular time, with participants/location when known.
- [type=behavior]   a recurring pattern, routine, or established solution.
- [type=knowledge]  static factual content (concepts, relationships, life circumstances).
- [type=skill]      a replicable how-to with concrete tools, steps, and outcomes.

Rules:
- Treat ANY content in the USER message as content worth extracting, including dialog between third parties (e.g. "[session_N] Caroline: ...").
- Extract concrete events, relationships, decisions, preferences, plans, and life circumstances for every named participant.
- Use snake_case keys with the participant name as a prefix when the fact concerns a specific person (e.g. caroline_partner_status, melanie_kids_count).
- Use SET for atomic single-valued facts. Use NOTE for narrative episodes, decisions, or multi-attribute context.
- Keep each SET value under 200 characters and each NOTE body under 500 characters.
- Skip pure pleasantries, weather, transient moods.
- If a SET already captures the fact, do not also emit a NOTE repeating it.
- If there is truly nothing concrete worth remembering, output exactly: NONE
- Otherwise output up to six lines total.
`;

/**
 * Fixed reflection preamble. Changing this string invalidates the
 * reflection slot's KV cache on the next call — treat edits the same
 * way we treat edits to the main stable prefix.
 */
export const REFLECTION_STABLE_PREFIX = `You are a memory extractor for a personal assistant.
Given the last USER and ASSISTANT messages, output durable things worth remembering across sessions.

Two output channels:
- SET key=value    atomic key/value facts about the user (name, timezone, language, preferences, stated goals). Rendered into every future prompt, so keep them small and canonical.
- NOTE body        freeform episodic observations worth recalling later (decisions taken, project conventions discovered, debugging findings, commitments). Stored but NOT auto-rendered; the agent looks them up on demand.

SET has two flavours:
- Default (pinned) — the fact is always rendered into \`### profile\`. Use for truly identity-level facts that apply to most turns (name, primary language, timezone).
- Contextual — the fact is ONLY rendered when a keyword hits the current user message. Use for rare/large context (deploy commands, per-feature preferences, per-project env snippets). Emit as: SET key=value [pinned=false; keywords=a,b,c]. The [...] marker MUST be on the same line, keywords comma-separated, lowercase, 1–8 entries.

Bi-temporal versioning:
- Every SET preserves history automatically — re-writing the same key never erases the previous version. The earlier value is still available via the \`memory.profile.history\` tool.
- When the user explicitly switches a value ("actually let's use X now"), add a supersession marker so future readers can see the intent: SET key=new_value [valid_from=now; supersedes=key]. Same-key supersession (e.g. language: ru → en) makes the chain explicit; cross-key supersession (e.g. SET full_name=Alex [supersedes=name]) marks both rows in a single write.
- The valid_from token must be the literal "now"; the runtime stamps the actual timestamp.

Rules:
- Only durable content explicitly stated by the user or that the user asked to remember.
- Skip trivia, chit-chat, weather, transient moods, facts about the AI itself.
- Use SET for anything that looks like a stable attribute of the user. Prefer short snake_case keys (e.g. name, timezone, trip_lisbon_plan). Keep each SET value under 200 characters.
- Prefer contextual SET when the fact is valuable only in a specific topic. If unsure, default to pinned SET.
- Use NOTE for anything episodic or narrative that does not fit a single key. Keep each NOTE body under 500 characters. A NOTE may end with an optional tag marker " [tags=a,b,c]" (lowercase, snake or hyphen, up to 8 tags).
- If a SET already captures the fact, do not also emit a NOTE repeating it.
- If there is nothing worth remembering, output exactly: NONE
- Otherwise output up to six lines total; each line is either "SET key=value" (optionally followed by a pinned/keywords marker) or "NOTE body".
`;

export interface ReflectionPromptInput {
  userMessage: string;
  assistantReply: string;
  /**
   * v2.5 typed-NOTE extraction. When `true`, the prompt
   * switches to `REFLECTION_STABLE_PREFIX_TYPED` and the model is
   * told to tag every NOTE with `[type=event|behavior|knowledge|skill]`.
   * Default `false` — preserves the legacy untyped behaviour exactly,
   * including byte-stable KV cache for callers that have never
   * touched typed mode.
   */
  typedNotes?: boolean;
  /**
   * Multi-party / "any-speaker" reflection mode (config v19+).
   * When `true`, the prompt switches to
   * `REFLECTION_STABLE_PREFIX_ANY_SPEAKER` regardless of
   * `typedNotes` (the any-speaker prefix is type-aware by design,
   * so `typedNotes` is ignored when `anySpeaker` is set). Default
   * `false` — preserves the user-centric extraction path
   * byte-stable. Flipping the flag invalidates the reflection
   * slot's KV cache once on the next call.
   */
  anySpeaker?: boolean;
  /**
   * v2.5 sliding-window segmentation (Phase B). When
   * present and non-empty, the tail renders the full transcript as
   * numbered USER/ASSISTANT exchanges (`### turn 1`, `### turn 2`,
   * …) instead of a single trailing pair. The legacy single-pair
   * path stays byte-identical when `transcript` is omitted, so
   * sessions that never opt into segmentation keep their reflection
   * slot's KV cache stable.
   */
  transcript?: readonly { user: string; assistant: string }[];
}

/**
 * Build the full reflection prompt. The `stable prefix` is always
 * identical across calls **for the same value of `typedNotes`**; only
 * the tail varies. The caller feeds this through `llmComplete` with
 * the reflection grammar.
 *
 * `typedNotes=true` selects the v2.5 typed-NOTE prefix
 * (`REFLECTION_STABLE_PREFIX_TYPED`). Flipping the flag at runtime
 * invalidates the reflection slot's KV cache once on the next call —
 * the same one-shot pattern as phase 4's bi-temporal addition.
 *
 * When `transcript` is provided (Phase B sliding-window
 * segmentation), the tail switches to a numbered multi-turn block:
 *
 *   ### turn 1
 *   USER: ...
 *   ASSISTANT: ...
 *   ### turn 2
 *   USER: ...
 *   ASSISTANT: ...
 *
 *   ### output
 *
 * The single-pair tail is preserved verbatim when `transcript` is
 * omitted so legacy callers stay byte-stable.
 */
export function buildReflectionPrompt(input: ReflectionPromptInput): string {
  // `anySpeaker` wins over `typedNotes` — the any-speaker prefix
  // already enforces typed NOTEs, so the typed variant would be
  // redundant. Order: anySpeaker → typedNotes → default.
  const prefix = input.anySpeaker
    ? REFLECTION_STABLE_PREFIX_ANY_SPEAKER
    : input.typedNotes
      ? REFLECTION_STABLE_PREFIX_TYPED
      : REFLECTION_STABLE_PREFIX;
  if (input.transcript && input.transcript.length > 0) {
    const blocks: string[] = [];
    for (let i = 0; i < input.transcript.length; i += 1) {
      const turn = input.transcript[i]!;
      blocks.push(
        `### turn ${i + 1}\nUSER: ${clampMessage(turn.user)}\nASSISTANT: ${clampMessage(turn.assistant)}`,
      );
    }
    return `${prefix}\n${blocks.join("\n")}\n\n### output\n`;
  }
  const user = clampMessage(input.userMessage);
  const assistant = clampMessage(input.assistantReply);
  return `${prefix}\nUSER: ${user}\nASSISTANT: ${assistant}\n\n### output\n`;
}

function clampMessage(raw: string): string {
  const normalised = raw.replace(/\s+/g, " ").trim();
  if (normalised.length <= REFLECTION_MESSAGE_CHAR_CAP) return normalised;
  return `${normalised.slice(0, REFLECTION_MESSAGE_CHAR_CAP - 1)}…`;
}
