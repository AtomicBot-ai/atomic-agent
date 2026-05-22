/**
 * E11 — typed NOTE extraction (v2.5 Phase C) dataset.
 *
 * Three scenarios:
 *
 *  - `typed-roundtrip`  — fire an event-like and a behavior-like
 *    user turn under the typed-notes flag; assert the resulting
 *    `memories.tags` carry `type:event` / `type:behavior`.
 *  - `forbidden-soft`   — 10 trivial one-off events that the prompt's
 *    per-type forbidden lists tell the model NOT to label as
 *    `[type=skill]` / `[type=behavior]`. Soft floor — `<= 30%` wrong
 *    labels allowed (Q2: small models are noisy on this).
 *  - `legacy-compat`    — run S1 with the flag OFF (legacy untyped
 *    NOTEs) then S2 with the flag ON (typed). Assert that legacy
 *    rows from S1 are still recallable after S2 and that S2 added
 *    type-tagged rows.
 */

export interface TypedRoundtripPrompt {
  /** Free-form user message that should provoke a typed NOTE write. */
  text: string;
  /** The `type:*` tag we expect to appear on AT LEAST one new note. */
  expectedType: "event" | "behavior" | "knowledge" | "skill";
}

export interface ForbiddenSoftCase {
  /** Prompt that LOOKS like a one-off event / trivial action. */
  prompt: string;
  /** The type tag the model MUST NOT use for this case. */
  forbiddenType: "skill" | "behavior";
}

export interface E11RoundtripScenario {
  id: "typed-roundtrip";
  prompts: readonly TypedRoundtripPrompt[];
}

export interface E11ForbiddenScenario {
  id: "forbidden-soft";
  cases: readonly ForbiddenSoftCase[];
  /** Max allowed share of cases that produced the forbidden type. */
  maxForbiddenShare: number;
}

export interface E11LegacyScenario {
  id: "legacy-compat";
  legacyPrompts: readonly string[];
  typedPrompts: readonly TypedRoundtripPrompt[];
}

export type E11Scenario =
  | E11RoundtripScenario
  | E11ForbiddenScenario
  | E11LegacyScenario;

export const E11_ROUNDTRIP_PROMPTS: readonly TypedRoundtripPrompt[] = [
  // Single-occurrence specifics (date + location + name) — should
  // route to `event`, not `behavior` / `knowledge`.
  {
    text:
      "On 14 March 2026 I attended a one-day photography workshop with Maria at the Lisbon Marina. It was a one-off masterclass, not a recurring class.",
    expectedType: "event",
  },
  {
    text:
      "Yesterday evening at 7pm I had a single tasting dinner at Belcanto restaurant with my brother — first time visiting that place.",
    expectedType: "event",
  },
  // Repeating-pattern statements — should route to `behavior`.
  {
    text:
      "I always deploy production on Fridays at 4pm so the weekend acts as a buffer if something breaks.",
    expectedType: "behavior",
  },
  {
    text:
      "Every Monday morning I write a weekly plan in my notebook before opening Slack — I have done this for years.",
    expectedType: "behavior",
  },
];

export const E11_FORBIDDEN_CASES: readonly ForbiddenSoftCase[] = [
  {
    prompt:
      "I ran `docker ps` once last week to see what was up. Just a one-off check.",
    forbiddenType: "skill",
  },
  {
    prompt:
      "Earlier today I clicked the export button in Excel once. Routine UI action.",
    forbiddenType: "skill",
  },
  {
    prompt:
      "I sent a single Slack DM to my manager about lunch. Trivial daily exchange.",
    forbiddenType: "behavior",
  },
  {
    prompt:
      "Yesterday I once ran `git status` after switching branches. Nothing notable.",
    forbiddenType: "skill",
  },
  {
    prompt:
      "I opened my email inbox once this morning. Standard daily start.",
    forbiddenType: "behavior",
  },
  {
    prompt:
      "Earlier I clicked the refresh icon in the browser exactly once on a stale tab.",
    forbiddenType: "skill",
  },
  {
    prompt:
      "I typed my password into the laptop login once this morning.",
    forbiddenType: "skill",
  },
  {
    prompt:
      "I drank a glass of water with breakfast. Nothing special.",
    forbiddenType: "behavior",
  },
  {
    prompt:
      "I noticed the office printer was out of paper once this week.",
    forbiddenType: "behavior",
  },
  {
    prompt:
      "I clicked save in VS Code once when the file was already saved by autosave.",
    forbiddenType: "skill",
  },
];

// Event-style legacy prompts. "Remember that ..." routes to
// `memory.profile.set`, which writes to `profile_facts` not
// `memories` — so we phrase these as past events to provoke a NOTE
// write instead. With the flag OFF the resulting rows carry no
// `type:*` tag; with the flag ON, fresh rows carry one.
export const E11_LEGACY_PROMPTS: readonly string[] = [
  "Last Tuesday I had a long phone call with my sister Anna about her recent move to Berlin.",
  "Yesterday afternoon I visited the Museum of Modern Art in Lisbon and saw the new Bauhaus exhibition.",
];

export const E11_LEGACY_TYPED_PROMPTS: readonly TypedRoundtripPrompt[] = [
  {
    text:
      "On 18 May 2026 I gave a 30-minute keynote at the local Linux meetup in Lisbon — first time speaking publicly in over a year.",
    expectedType: "event",
  },
  {
    text:
      "Every Friday morning I review the team's weekly metrics in Notion before stand-up — it has been my routine for 8 months.",
    expectedType: "behavior",
  },
  {
    text:
      "I just learned that SQLite's WAL mode uses a shared-memory file (.shm) for synchronization between processes.",
    expectedType: "knowledge",
  },
];

export function getRoundtripScenario(): E11RoundtripScenario {
  return { id: "typed-roundtrip", prompts: E11_ROUNDTRIP_PROMPTS };
}

export function getForbiddenScenario(maxForbiddenShare = 0.3): E11ForbiddenScenario {
  return {
    id: "forbidden-soft",
    cases: E11_FORBIDDEN_CASES,
    maxForbiddenShare,
  };
}

export function getLegacyScenario(): E11LegacyScenario {
  return {
    id: "legacy-compat",
    legacyPrompts: E11_LEGACY_PROMPTS,
    typedPrompts: E11_LEGACY_TYPED_PROMPTS,
  };
}
