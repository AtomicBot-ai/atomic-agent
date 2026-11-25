import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../../memory/memory-store.js";
import { ProfileStore } from "../../memory/profile-store.js";
import { ImportFactsConsentError } from "../../memory/import-facts/index.js";
import { chatGptExportFixture } from "./chatgpt-export.fixture.js";
import { ImportFactsJobs } from "./import-facts-jobs.js";
import { listImportReceipts } from "./import-facts-receipts.js";
import {
  ImportFactsBusyError,
  ImportFactsJobNotReadyError,
  saveImportFacts,
  startImportFacts,
  undoImportFacts,
  type ImportFactsServiceDeps,
} from "./import-facts-service.js";

let dir: string;
let profile: ProfileStore;
let memory: MemoryStore;
let deps: ImportFactsServiceDeps;
let complete: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "import-facts-service-"));
  const dbFile = join(dir, "memory.sqlite");
  profile = new ProfileStore({ dbFile });
  memory = new MemoryStore({ dbFile, maxEntries: 100 });
  writeFileSync(
    join(dir, "conversations.json"),
    JSON.stringify(chatGptExportFixture(["I'm a designer from Berlin, help me with my portfolio site"])),
  );
  complete = vi.fn(async () => ({ content: "SET job=designer\nSET city=Berlin\n", toolCalls: [] }));
  deps = {
    jobs: new ImportFactsJobs(),
    llm: { providers: [{ id: "local-llama", kind: "llama-server" }], activeTextProvider: "local-llama", getProvider: () => ({ complete: complete as never }) },
    profileStore: profile,
    memoryStore: memory,
    stateDir: dir,
  };
});
afterEach(() => {
  profile.close();
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("facts import service (ATO-1617)", () => {
  it("start → candidates → save only the ticked ones → undo by receipt", async () => {
    const job = startImportFacts(deps, { source: "chatgpt", path: dir, engine: { kind: "local" } });
    expect(job).toMatchObject({ providerId: "local-llama", local: true });
    await deps.jobs.settled();
    const done = deps.jobs.get(job.id)!;
    expect(done.state).toBe("done");
    expect(done.progress).toMatchObject({ chunksDone: 1, chunksTotal: 1 });
    const job_ = done.candidates!.find((c) => c.key === "job")!;
    expect(done.candidates!.map((c) => c.key).sort()).toEqual(["city", "job"]);

    const saved = saveImportFacts(deps, job.id, [job_.id]);
    expect(saved).toMatchObject({ saved: 1, skipped: 0, failed: 0 });
    expect(profile.get("job")?.value).toBe("designer");
    expect(profile.get("city")).toBeNull();
    expect(listImportReceipts(dir)).toHaveLength(1);
    // The job and its candidates are gone after saving.
    expect(deps.jobs.get(job.id)).toBeNull();

    expect(undoImportFacts(deps, saved.receiptId!)).toMatchObject({ profileRemoved: 1 });
    expect(profile.get("job")).toBeNull();
    expect(listImportReceipts(dir)).toHaveLength(0);
  });

  it("a cloud engine without consent sends nothing", () => {
    deps.llm = { ...deps.llm, providers: [{ id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }] };
    expect(() =>
      startImportFacts(deps, { source: "chatgpt", path: dir, engine: { kind: "cloud", provider: "openrouter", cloudConsent: false } }),
    ).toThrow(ImportFactsConsentError);
    expect(complete).not.toHaveBeenCalled();
  });

  it("one run at a time; saving a running job is refused", async () => {
    let release!: () => void;
    complete.mockImplementation(() => new Promise((r) => { release = () => r({ content: "NONE", toolCalls: [] }); }));
    const job = startImportFacts(deps, { source: "chatgpt", path: dir, engine: { kind: "local" } });
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    expect(() => startImportFacts(deps, { source: "chatgpt", path: dir, engine: { kind: "local" } })).toThrow(ImportFactsBusyError);
    expect(() => saveImportFacts(deps, job.id, [])).toThrow(ImportFactsJobNotReadyError);
    release();
    await deps.jobs.settled();
  });

  it("a stopped run keeps what it found; an unreadable export fails the job with the reason", async () => {
    const bad = startImportFacts(deps, { source: "chatgpt", path: join(dir, "missing.zip"), engine: { kind: "local" } });
    await deps.jobs.settled();
    expect(deps.jobs.get(bad.id)).toMatchObject({ state: "failed" });
    expect(deps.jobs.get(bad.id)!.error).toMatch(/no such file/);

    const job = startImportFacts(deps, { source: "chatgpt", path: dir, engine: { kind: "local" } });
    expect(deps.jobs.stop(job.id)).toBe(true);
    await deps.jobs.settled();
    expect(deps.jobs.get(job.id)).toMatchObject({ state: "stopped", candidates: [] });
  });
});
