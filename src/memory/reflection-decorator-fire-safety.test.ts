import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "./memory-store.js";
import { ProfileStore } from "./profile-store.js";
import { LessonStore } from "./lessons/lesson-store.js";
import { ProcedureStore } from "./procedures/procedure-store.js";
import { createVoteAwareReflectionRunner } from "./voting/vote-aware-reflection.js";
import { createLinkAwareReflectionRunner } from "./links/link-aware-reflection.js";
import type { ReflectionInput, ReflectionRunner } from "./reflection/reflection-runner.js";
import type { VoteRunner, VoteRunnerInput } from "./voting/vote-runner.js";
import type {
  LinkGeneratorInput,
  LinkGeneratorRunner,
} from "./links/link-generator-runner.js";

/**
 * Regression pin for the reflection decorators' fire-safety contract.
 *
 * `ReflectionRunner.reflect()` is documented fire-safe — see the
 * invariants block in `reflection/reflection-runner.ts` — and
 * `AgentLoop.runTurn` relies on that by calling it as a bare `void`.
 * Both decorators hydrate candidate ids out of SQLite-backed stores
 * *after* awaiting the inner runner, and that hydration used to sit
 * outside every `try`.
 *
 * The live failure that motivated this file: runtime `shutdown()`
 * calls `reflectionRunner.abortPending()` and then closes every store
 * (`bootstrap.ts`). The abort settles the *inner* reflection, so the
 * decorator's continuation resumes and reads stores the shutdown has
 * since closed. better-sqlite3 answers a statement on a closed handle
 * with a real `TypeError: The database connection is not open`, which
 * escaped `reflect()` and landed as an unhandled rejection.
 */

interface Fixture {
  dir: string;
  memoryStore: MemoryStore;
  profileStore: ProfileStore;
  lessonStore: LessonStore;
  procedureStore: ProcedureStore;
  ids: {
    memory: number;
    memory2: number;
    profile: number;
    lesson: number;
    procedure: number;
  };
  closeAll: () => void;
}

const fixtures: Fixture[] = [];

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "atomic-reflect-firesafe-"));
  const dbFile = join(dir, "memory.sqlite");
  const memoryStore = new MemoryStore({
    dbFile,
    maxEntries: 100,
    eviction: { utilityWeighted: true, maxAgeMs: 1_000_000 },
  });
  const profileStore = new ProfileStore({ dbFile });
  const lessonStore = new LessonStore({ dbFile });
  const procedureStore = new ProcedureStore({ dbFile });

  const memory = memoryStore.store({ content: "note one" }).id;
  const memory2 = memoryStore.store({ content: "note two" }).id;
  const profile = profileStore.set("editor", "vim").id;
  const lesson = lessonStore.create({
    activation: "when the build fails",
    principle: "read the first error",
    parentIds: [memory],
  }).id;
  const procedure = procedureStore.create({
    activation: "when releasing",
    steps: [
      { description: "run the tests" },
      { description: "tag the commit" },
    ],
    parentLessonIds: [lesson],
    parentMemoryIds: [memory],
  }).id;

  const fx: Fixture = {
    dir,
    memoryStore,
    profileStore,
    lessonStore,
    procedureStore,
    ids: { memory, memory2, profile, lesson, procedure },
    closeAll() {
      // Mirrors bootstrap `shutdown()` ordering.
      try {
        profileStore.close();
      } catch {
        /* already closed */
      }
      try {
        lessonStore.close();
      } catch {
        /* already closed */
      }
      try {
        procedureStore.close();
      } catch {
        /* already closed */
      }
      try {
        memoryStore.close();
      } catch {
        /* already closed */
      }
    },
  };
  fixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const fx of fixtures.splice(0)) {
    fx.closeAll();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

/** Inner runner that resolves normally, optionally with a side effect. */
function innerRunner(onReflect?: () => void): ReflectionRunner {
  return {
    async reflect() {
      onReflect?.();
    },
    abortPending() {
      /* no-op */
    },
  };
}

function recordingVoteRunner(calls: VoteRunnerInput[]): VoteRunner {
  return {
    async run(input) {
      calls.push(input);
      return { outcome: "applied", applied: 1, rejected: 0 };
    },
    abortPending() {
      /* no-op */
    },
  };
}

function recordingLinkGenerator(calls: LinkGeneratorInput[]): LinkGeneratorRunner {
  return {
    async generate(input) {
      calls.push(input);
      return 1;
    },
    abortPending() {
      /* no-op */
    },
  };
}

function inputFor(fx: Fixture): ReflectionInput {
  return {
    sessionId: "s1",
    userMessage: "hello",
    assistantReply: "hi",
    recalledMemoryIds: [fx.ids.memory, fx.ids.memory2],
    recalledLessonIds: [fx.ids.lesson],
    recalledProfileFactIds: [fx.ids.profile],
    recalledProcedureIds: [fx.ids.procedure],
  };
}

describe("reflection decorators are fire-safe across a store close", () => {
  it("premise: a better-sqlite3 read after close throws a TypeError", () => {
    const fx = makeFixture();
    expect(fx.memoryStore.get(fx.ids.memory)).not.toBeNull();
    fx.closeAll();
    let thrown: unknown;
    try {
      fx.memoryStore.get(fx.ids.memory);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain("database connection is not open");
  });

  it("vote-aware: hydration reaches the vote runner while the stores are open", async () => {
    const fx = makeFixture();
    const calls: VoteRunnerInput[] = [];
    const runner = createVoteAwareReflectionRunner({
      reflection: innerRunner(),
      voteRunner: recordingVoteRunner(calls),
      memoryStore: fx.memoryStore,
      lessonStore: fx.lessonStore,
      profileStore: fx.profileStore,
      procedureStore: fx.procedureStore,
    });

    await runner.reflect(inputFor(fx));

    expect(calls).toHaveLength(1);
    // All four kinds hydrated — this is what the close-race test kills.
    expect(calls[0]!.candidates.map((c) => c.kind).sort()).toEqual([
      "lesson",
      "memory",
      "memory",
      "procedure",
      "profile",
    ]);
  });

  it("vote-aware: a store closed mid-flight does not reject reflect()", async () => {
    const fx = makeFixture();
    const calls: VoteRunnerInput[] = [];
    const runner = createVoteAwareReflectionRunner({
      // The shutdown race: `abortPending()` settles the inner
      // reflection, then the closes land before this continuation
      // gets to hydrate.
      reflection: innerRunner(() => fx.closeAll()),
      voteRunner: recordingVoteRunner(calls),
      memoryStore: fx.memoryStore,
      lessonStore: fx.lessonStore,
      profileStore: fx.profileStore,
      procedureStore: fx.procedureStore,
    });

    await expect(runner.reflect(inputFor(fx))).resolves.toBeUndefined();
    // Hydration failed wholesale, so the vote runner is never called
    // with a partial allowlist.
    expect(calls).toHaveLength(0);
  });

  it("vote-aware: a closed profile store alone does not reject reflect()", async () => {
    const fx = makeFixture();
    const calls: VoteRunnerInput[] = [];
    const runner = createVoteAwareReflectionRunner({
      reflection: innerRunner(() => fx.profileStore.close()),
      voteRunner: recordingVoteRunner(calls),
      memoryStore: fx.memoryStore,
      lessonStore: fx.lessonStore,
      profileStore: fx.profileStore,
      procedureStore: fx.procedureStore,
    });

    await expect(runner.reflect(inputFor(fx))).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("link-aware: hydration reaches the link generator while the store is open", async () => {
    const fx = makeFixture();
    const calls: LinkGeneratorInput[] = [];
    const runner = createLinkAwareReflectionRunner({
      reflection: innerRunner(),
      linkGenerator: recordingLinkGenerator(calls),
      notesStore: fx.memoryStore,
    });

    await runner.reflect(inputFor(fx));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.candidates.map((c) => c.body)).toEqual([
      "note one",
      "note two",
    ]);
  });

  it("link-aware: a store closed mid-flight does not reject reflect()", async () => {
    const fx = makeFixture();
    const calls: LinkGeneratorInput[] = [];
    const runner = createLinkAwareReflectionRunner({
      reflection: innerRunner(() => fx.closeAll()),
      linkGenerator: recordingLinkGenerator(calls),
      notesStore: fx.memoryStore,
    });

    await expect(runner.reflect(inputFor(fx))).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("both decorators composed: the close race still cannot reject", async () => {
    const fx = makeFixture();
    const voteCalls: VoteRunnerInput[] = [];
    const linkCalls: LinkGeneratorInput[] = [];
    const runner = createVoteAwareReflectionRunner({
      reflection: createLinkAwareReflectionRunner({
        reflection: innerRunner(() => fx.closeAll()),
        linkGenerator: recordingLinkGenerator(linkCalls),
        notesStore: fx.memoryStore,
      }),
      voteRunner: recordingVoteRunner(voteCalls),
      memoryStore: fx.memoryStore,
      lessonStore: fx.lessonStore,
      profileStore: fx.profileStore,
      procedureStore: fx.procedureStore,
    });

    await expect(runner.reflect(inputFor(fx))).resolves.toBeUndefined();
    expect(linkCalls).toHaveLength(0);
    expect(voteCalls).toHaveLength(0);
  });
});
