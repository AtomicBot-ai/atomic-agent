import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ImportFactsView } from "./import-facts-view.js";
import { createInitialImportFactsState } from "./import-facts-state.js";

describe("ImportFactsView (ATO-1627)", () => {
  it("form says which model reads and warns for the cloud", () => {
    const base = { ...createInitialImportFactsState(), localLabel: "local-llama", cloudProvider: "openrouter" };
    expect(render(<ImportFactsView facts={base} />).lastFrame()).toContain("your chats stay on this computer");
    expect(render(<ImportFactsView facts={{ ...base, cloud: true }} />).lastFrame()).toContain("will be sent to openrouter");
  });

  it("running shows part N of M", () => {
    const s = { ...createInitialImportFactsState(), phase: "running" as const, readingWith: { providerId: "local-llama", local: true }, progress: { chunksDone: 2, chunksTotal: 5, candidates: 3 } };
    expect(render(<ImportFactsView facts={s} />).lastFrame()).toContain("part 2 of 5, 3 found");
  });

  it("review lists candidates with ticks and quotes; done shows the counts", () => {
    const s = {
      ...createInitialImportFactsState(),
      phase: "review" as const,
      candidates: [{ id: "c0-0", kind: "profile" as const, key: "job", value: "designer", pinned: true, chatId: "a", quote: "I'm a designer" }],
      checked: ["c0-0"],
    };
    const frame = render(<ImportFactsView facts={s} />).lastFrame() ?? "";
    expect(frame).toContain("job: designer");
    expect(frame).toContain("I'm a designer");
    const done = { ...s, phase: "done" as const, result: { saved: 1, skipped: 2, conflicts: 0, failed: 0 } };
    expect(render(<ImportFactsView facts={done} />).lastFrame()).toContain("Saved 1, skipped 2 (already known)");
  });
});
