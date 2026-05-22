/**
 * E6 dataset. Six hand-written clusters fed to the combined
 * lesson+procedure distill call. Three are clearly procedural —
 * the model SHOULD emit a `PROCEDURE` line with coherent steps.
 * Three are clearly conceptual — the model SHOULD NOT hallucinate
 * a procedure (lesson-only output is the right answer).
 *
 * Each cluster carries:
 *  - episode bodies that look like real notes / tool traces
 *    (the consolidator only sees the `content` field at distill time),
 *  - sharedTags that the prompt's tag-hint surfaces,
 *  - gold metadata: expected lesson signal + expected procedure
 *    decision (`yes` | `no`) + (when `yes`) expected activation
 *    keywords and a sketch of the canonical tool-call shape.
 *
 * The runner grades:
 *  - extraction rate over procedural clusters (procedure present),
 *  - false-procedure rate over conceptual clusters (procedure absent),
 *  - step coherence (LLM-judge grades each step for the procedural
 *    clusters that DID produce a procedure),
 *  - lesson-still-produced rate (every cluster should yield a
 *    lesson regardless of the procedure decision — invariant 21).
 */

export type ClusterKind = "procedural" | "conceptual";

export interface DistillEpisode {
  content: string;
  tags?: readonly string[];
}

export interface ProceduralExpectations {
  /** Substrings the activation phrase should contain (case-insensitive). */
  activationKeywords: readonly string[];
  /**
   * Canonical step sketch. Each entry lists keywords expected in the
   * step description; the judge uses these as anchors when grading
   * step coherence (not as exact-match — the model can paraphrase).
   */
  expectedStepShape: readonly {
    keywords: readonly string[];
    toolHint?: string;
  }[];
}

export interface ProcDistillCase {
  id: string;
  label: string;
  kind: ClusterKind;
  sharedTags: readonly string[];
  episodes: readonly DistillEpisode[];
  /**
   * Free-form rubric handed to the LLM judge — describes what the
   * lesson half should look like (so we can score lessonStillProduced
   * for quality, not just presence).
   */
  lessonRubric: string;
  /** Only present when `kind === "procedural"`. */
  procedural?: ProceduralExpectations;
  /**
   * Only present when `kind === "conceptual"`. Free-form rationale
   * surfaced into the judge prompt so a human reading the report
   * understands why this cluster is non-procedural.
   */
  conceptualNote?: string;
}

export const PROCEDURE_DISTILL_CASES: readonly ProcDistillCase[] = [
  // ----------------------------------------------------------------
  // PROCEDURAL clusters
  // ----------------------------------------------------------------
  {
    id: "procedural-csv-scan",
    label: "Three CSV-scan episodes — same tool chain, different files",
    kind: "procedural",
    sharedTags: ["csv", "tooling"],
    episodes: [
      {
        content:
          "asked to find rows mentioning ACME-2024 across the exports folder. Ran os.fs.glob '*.csv' in exports/, then os.fs.grep -F 'ACME-2024' on each match, then summarised 18 hits in 4 files.",
        tags: ["csv", "tooling"],
      },
      {
        content:
          "needed every CSV row containing 'preferred_billing'. os.fs.glob '*.csv' inside reports/2024-Q3/, os.fs.grep 'preferred_billing' across the matches, returned 6 rows.",
        tags: ["csv", "tooling"],
      },
      {
        content:
          "user wanted invoice ids in CSV dumps. os.fs.glob '*.csv' over data/billing/, os.fs.grep on 'INV-' pattern, opened the top three files with os.fs.read to verify column index.",
        tags: ["csv", "tooling", "billing"],
      },
    ],
    lessonRubric:
      "Lesson should describe the recurring pattern: scanning CSVs for a substring is a two-step tool chain. Activation should mention CSV scan / substring search. Principle should encode 'glob then grep' as the canonical approach.",
    procedural: {
      activationKeywords: ["csv", "scan"],
      expectedStepShape: [
        { keywords: ["glob", "csv"], toolHint: "os.fs.glob" },
        { keywords: ["grep"], toolHint: "os.fs.grep" },
      ],
    },
  },
  {
    id: "procedural-deploy-bake",
    label: "Three deploy episodes — same bake → verify → tail-logs chain",
    kind: "procedural",
    sharedTags: ["deploy", "ops"],
    episodes: [
      {
        content:
          "deployed atomic-agent to prod. Ran bin/deploy.sh --env=prod --bake via os.shell.run, then curl https://atomic.app/health via os.http.request, then tailed the journalctl service for 30 lines via os.shell.run.",
        tags: ["deploy", "ops"],
      },
      {
        content:
          "rolled out the v3.4.1 hotfix. os.shell.run 'bin/deploy.sh --env=prod --bake', os.http.request GET https://atomic.app/health for the 200 check, os.shell.run 'journalctl -u atomic-agent -n 50'.",
        tags: ["deploy", "ops", "hotfix"],
      },
      {
        content:
          "staging push followed by a prod promote. Ran bin/deploy.sh --env=staging --bake then bin/deploy.sh --env=prod --bake. Verified each with the /health http.request. Tailed both journals after.",
        tags: ["deploy", "ops"],
      },
    ],
    lessonRubric:
      "Lesson should encode the deploy recipe: bake first, hit /health second, tail journal third. Activation should mention deploying atomic-agent.",
    procedural: {
      activationKeywords: ["deploy"],
      expectedStepShape: [
        { keywords: ["bake", "deploy"], toolHint: "os.shell.run" },
        { keywords: ["health"], toolHint: "os.http.request" },
        { keywords: ["journal", "log"], toolHint: "os.shell.run" },
      ],
    },
  },
  {
    id: "procedural-lint-cleanup",
    label: "Three lint-cleanup episodes — same format → lint → commit chain",
    kind: "procedural",
    sharedTags: ["lint", "git"],
    episodes: [
      {
        content:
          "pre-commit hook failed on tabs/spaces. Ran 'pnpm prettier --write src/' via os.shell.run, then 'pnpm eslint --fix src/' via os.shell.run, then git add -p via os.shell.run.",
        tags: ["lint", "git"],
      },
      {
        content:
          "another lint regression after a PR rebase. pnpm prettier --write . then pnpm eslint --fix .; git add -A and git commit --amend with os.shell.run.",
        tags: ["lint", "git"],
      },
      {
        content:
          "ran the same fix sequence after fixing a typescript-eslint upgrade. prettier --write, eslint --fix, git add.",
        tags: ["lint", "git"],
      },
    ],
    lessonRubric:
      "Lesson should describe how to fix lint failures from the pre-commit hook in one go: format → lint --fix → stage.",
    procedural: {
      activationKeywords: ["lint", "fix"],
      expectedStepShape: [
        { keywords: ["prettier", "format"], toolHint: "os.shell.run" },
        { keywords: ["eslint", "lint"], toolHint: "os.shell.run" },
        { keywords: ["git", "add"], toolHint: "os.shell.run" },
      ],
    },
  },

  // ----------------------------------------------------------------
  // CONCEPTUAL clusters (procedure MUST NOT be emitted)
  // ----------------------------------------------------------------
  {
    id: "conceptual-architectural-pref",
    label:
      "Three notes about a preference for monorepo packaging — pure conceptual, no tool chain",
    kind: "conceptual",
    sharedTags: ["architecture", "preference"],
    episodes: [
      {
        content:
          "thought-loud: we prefer monorepo over polyrepo because cross-team refactors stay atomic. No code touched, just a doc note.",
        tags: ["architecture", "preference"],
      },
      {
        content:
          "talked with @maria about repo split. she agreed monorepo wins as long as we keep ownership boundaries explicit via CODEOWNERS.",
        tags: ["architecture", "preference"],
      },
      {
        content:
          "long-running discussion thread: monorepo is the default, splits require an RFC. Nothing was executed.",
        tags: ["architecture", "preference"],
      },
    ],
    lessonRubric:
      "Lesson should encode the team preference for monorepo and the CODEOWNERS guardrail. Activation: 'when discussing repo organisation' or similar.",
    conceptualNote:
      "These are stated preferences and discussion notes — no commands, no tool calls. The right behavior is a lesson with NO procedure half.",
  },
  {
    id: "conceptual-debugging-insight",
    label: "Three reflective notes about a tricky bug class — no recipe",
    kind: "conceptual",
    sharedTags: ["debugging", "insight"],
    episodes: [
      {
        content:
          "noticed that the flaky CI failures correlate with high disk IO on the test runner — the WAL fsync window seems to be the culprit, not the code.",
        tags: ["debugging", "insight"],
      },
      {
        content:
          "another flake on the same suite. Same disk pattern. Looks like the runner co-tenant is doing heavy IO.",
        tags: ["debugging", "insight"],
      },
      {
        content:
          "third repro: flake disappears when we move the suite to a dedicated runner. Confirmed it is IO contention, not a test bug.",
        tags: ["debugging", "insight"],
      },
    ],
    lessonRubric:
      "Lesson should encode the diagnosis: flaky-CI repros correlate with disk IO on shared runners; investigate isolation before treating tests as buggy.",
    conceptualNote:
      "There is a recurring observation but no canonical action chain — we did NOT decide 'every time we see a flake, run X then Y'. Procedure should NOT be emitted.",
  },
  {
    id: "conceptual-communication-style",
    label: "Three notes about preferred meeting cadence — pure soft signal",
    kind: "conceptual",
    sharedTags: ["meetings", "preference"],
    episodes: [
      {
        content:
          "user prefers async stand-ups in the #standup-bot channel over live calls.",
        tags: ["meetings", "preference"],
      },
      {
        content:
          "reminded again — async is the default. live calls only if there is a blocker.",
        tags: ["meetings", "preference"],
      },
      {
        content:
          "user dropped from a sync planning call and posted the same content in writing — confirms the preference.",
        tags: ["meetings", "preference"],
      },
    ],
    lessonRubric:
      "Lesson should encode the user's async-first communication preference; activation should mention scheduling meetings or stand-ups.",
    conceptualNote:
      "These are interpersonal preferences. There is no tool-call procedure for 'follow this preference' — the lesson alone is the right output.",
  },
];

export interface E6DecisionBoundaries {
  /** Fraction of procedural clusters with extracted procedure (gold: 3/3). */
  minExtractionRate: number;
  /** Fraction of conceptual clusters with wrongly extracted procedure. */
  maxFalseProcedureRate: number;
  /** Mean judge score over emitted procedure steps. */
  minStepCoherence: number;
  /** Lesson half should always be present (invariant 21). */
  minLessonStillProduced: number;
}

export const DEFAULT_E6_BOUNDS: E6DecisionBoundaries = {
  minExtractionRate: 0.66,
  maxFalseProcedureRate: 0.34,
  minStepCoherence: 0.6,
  minLessonStillProduced: 0.85,
};
