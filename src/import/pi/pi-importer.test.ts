import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../session/index.js";
import { parseSkillFile } from "../../skills/skill-manifest.js";
import { resolvePiOptions } from "./import-options.js";
import { PiImporter } from "./pi-importer.js";
import { PiSource } from "./pi-source.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

const T0 = Date.parse("2026-08-02T10:00:00Z");

// Verbatim fixture from the upstream Pi repo
// (packages/coding-agent/test/fixtures/skills/valid-skill/SKILL.md).
const PI_FIXTURE_SKILL_MD = [
  "---",
  "name: valid-skill",
  "description: A valid skill for testing purposes.",
  "---",
  "",
  "# Valid Skill",
  "",
  "This is a valid skill that follows the Agent Skills standard.",
  "",
].join("\n");

// Frontmatter shaped like real ecosystem skills: agentskills.io fields
// this parser does not model (license, allowed-tools) must pass through.
const PI_EXTENSION_SKILL_MD = [
  "---",
  "name: semantic-compression",
  "description: Re-encode verbose prose into a dense telegraphic register.",
  "license: MIT",
  "compatibility: pi",
  "allowed-tools: [read, bash]",
  "---",
  "",
  "# Semantic Compression",
  "",
].join("\n");

describe("PiImporter", () => {
  let sourceDir: string;
  let stateDir: string;
  let sessionStore: SessionStore;

  function buildImporter(): PiImporter {
    return new PiImporter({
      source: new PiSource(sourceDir),
      sessionStore,
      globalSkillsDir: join(stateDir, "skills"),
      workingDirFallback: "/fallback",
    });
  }

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "pi-imp-src-"));
    stateDir = mkdtempSync(join(tmpdir(), "pi-imp-dst-"));
    sessionStore = new SessionStore({
      dbFile: join(stateDir, "sessions.sqlite"),
    });
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(sourceDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    rmSync(stateDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  function seedSkill(segments: string[], manifest: string): void {
    const dir = join(sourceDir, "skills", ...segments);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), manifest);
    writeFileSync(join(dir, "notes.txt"), "extra resource");
  }

  function seedSession(): void {
    const dir = join(sourceDir, "sessions", "--work--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-08-02T10-00-00-000Z_sess-1.jsonl"),
      [
        line({
          type: "session",
          version: 3,
          id: "sess-1",
          timestamp: "2026-08-02T10:00:00.000Z",
          cwd: "/work",
        }),
        line({
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-08-02T10:00:01.000Z",
          message: { role: "user", content: "hello", timestamp: T0 },
        }),
        line({
          type: "message",
          id: "e2",
          parentId: "e1",
          timestamp: "2026-08-02T10:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            stopReason: "stop",
            timestamp: T0 + 1000,
          },
        }),
      ].join(""),
    );
  }

  it("imports nested skills and sessions, round-tripping real manifests", async () => {
    seedSkill(["valid-skill"], PI_FIXTURE_SKILL_MD);
    seedSkill(["group", "compression"], PI_EXTENSION_SKILL_MD);
    seedSession();

    const report = await buildImporter().run({
      options: resolvePiOptions(),
      execute: true,
      overwrite: false,
    });

    expect(report.summary).toEqual({
      migrated: 3,
      skipped: 0,
      conflict: 0,
      error: 0,
    });
    // Installed under the manifest name, whatever the source nesting was.
    const installed = join(stateDir, "skills", "semantic-compression");
    expect(existsSync(join(installed, "notes.txt"))).toBe(true);
    const roundTripped = parseSkillFile(
      readFileSync(join(installed, "SKILL.md"), "utf8"),
    );
    expect(roundTripped.manifest.name).toBe("semantic-compression");
    expect(roundTripped.manifest.version).toBe("0.0.0");

    const session = sessionStore.load("pi:sess-1");
    expect(session).not.toBeNull();
    expect(session!.workingDir).toBe("/work");
    expect(session!.metadata.importedFrom).toBe("pi");
    expect(session!.turns).toHaveLength(2);
  });

  it("previews without writing and re-runs idempotently", async () => {
    seedSkill(["valid-skill"], PI_FIXTURE_SKILL_MD);
    seedSession();
    const importer = buildImporter();

    const preview = await importer.run({
      options: resolvePiOptions(),
      execute: false,
      overwrite: false,
    });
    expect(preview.executed).toBe(false);
    expect(preview.summary.migrated).toBe(2);
    expect(existsSync(join(stateDir, "skills", "valid-skill"))).toBe(false);
    expect(sessionStore.load("pi:sess-1")).toBeNull();

    await importer.run({
      options: resolvePiOptions(),
      execute: true,
      overwrite: false,
    });
    const rerun = await importer.run({
      options: resolvePiOptions(),
      execute: true,
      overwrite: false,
    });
    expect(rerun.summary).toEqual({
      migrated: 0,
      skipped: 2,
      conflict: 0,
      error: 0,
    });
  });

  it("reports same-name skills from two source dirs the same way in preview and execute", async () => {
    const fooMd = "---\nname: foo\ndescription: One copy\n---\n";
    seedSkill(["personal", "foo"], fooMd);
    seedSkill(["work", "foo"], fooMd);
    seedSkill(["personal", "bar"], "---\nname: bar\ndescription: Original\n---\n");
    seedSkill(["work", "bar"], "---\nname: bar\ndescription: Diverged\n---\n");
    const importer = buildImporter();
    const run = (execute: boolean) =>
      importer.run({
        options: resolvePiOptions({ exclude: ["sessions"] }),
        execute,
        overwrite: true,
      });

    const rows = (report: Awaited<ReturnType<typeof run>>) =>
      report.items.map((item) => [item.source, item.status, item.reason]);
    const preview = await run(false);
    expect(rows(preview)).toEqual([
      ["personal/bar", "migrated", undefined],
      ["personal/foo", "migrated", undefined],
      ["work/bar", "conflict", "same skill name as personal/bar with a different SKILL.md; not imported"],
      ["work/foo", "skipped", "duplicate of personal/foo"],
    ]);
    // The duplicate verdicts do not depend on what execute installed —
    // even with --overwrite the first claimant keeps the destination.
    const final = await run(true);
    expect(rows(final)).toEqual(rows(preview));
    expect(
      readFileSync(
        join(stateDir, "skills", "bar", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Original");
  });

  it("caps sessions at the limit, newest first", async () => {
    seedSession();
    const dir = join(sourceDir, "sessions", "--work--");
    const older = join(dir, "2026-08-01T00-00-00-000Z_sess-0.jsonl");
    writeFileSync(
      older,
      [
        line({ type: "session", version: 3, id: "sess-0", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/work" }),
        line({
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-08-01T00:00:01.000Z",
          message: { role: "user", content: "old", timestamp: T0 - 86_400_000 },
        }),
      ].join(""),
    );
    utimesSync(older, new Date(T0 - 86_400_000), new Date(T0 - 86_400_000));

    const report = await buildImporter().run({
      options: resolvePiOptions({ exclude: ["skills"] }),
      execute: true,
      overwrite: false,
      limit: 1,
    });
    expect(report.items).toMatchObject([
      { kind: "sessions", source: "sess-1", status: "migrated" },
    ]);
    expect(sessionStore.load("pi:sess-0")).toBeNull();
  });

  it("skips a header-only transcript as no messages", async () => {
    const dir = join(sourceDir, "sessions", "--work--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-08-02T10-00-00-000Z_sess-empty.jsonl"),
      line({ type: "session", version: 3, id: "sess-empty", timestamp: "2026-08-02T10:00:00.000Z", cwd: "/work" }),
    );
    const report = await buildImporter().run({
      options: resolvePiOptions({ exclude: ["skills"] }),
      execute: true,
      overwrite: false,
    });
    expect(report.items).toMatchObject([
      { kind: "sessions", source: "sess-empty", status: "skipped", reason: "no messages" },
    ]);
  });

  it("flags a differing installed skill and honours overwrite", async () => {
    seedSkill(["valid-skill"], PI_FIXTURE_SKILL_MD);
    const installed = join(stateDir, "skills", "valid-skill");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, "SKILL.md"),
      "---\nname: valid-skill\ndescription: An older copy\n---\n",
    );

    const conflicted = await buildImporter().run({
      options: resolvePiOptions({ exclude: ["sessions"] }),
      execute: true,
      overwrite: false,
    });
    expect(conflicted.items).toMatchObject([
      {
        kind: "skills",
        status: "conflict",
        reason: "skill exists with a different SKILL.md; use --overwrite",
      },
    ]);

    const overwritten = await buildImporter().run({
      options: resolvePiOptions({ exclude: ["sessions"] }),
      execute: true,
      overwrite: true,
    });
    expect(overwritten.items).toMatchObject([
      { kind: "skills", status: "migrated", reason: "overwritten" },
    ]);
    expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toBe(
      PI_FIXTURE_SKILL_MD,
    );
  });

  it("reports an unparseable manifest as an error item", async () => {
    seedSkill(["broken"], "no frontmatter here");
    const report = await buildImporter().run({
      options: resolvePiOptions({ exclude: ["sessions"] }),
      execute: true,
      overwrite: false,
    });
    expect(report.items).toMatchObject([
      { kind: "skills", source: "broken", status: "error" },
    ]);
    expect(report.items[0]!.reason).toMatch(/invalid SKILL\.md/);
  });

  it("reports empty domains as skipped with a reason", async () => {
    const report = await buildImporter().run({
      options: resolvePiOptions(),
      execute: true,
      overwrite: false,
    });
    expect(report.items).toMatchObject([
      { kind: "skills", status: "skipped" },
      { kind: "sessions", status: "skipped" },
    ]);
    expect(report.items[0]!.reason).toMatch(/no skills found in /);
    expect(report.items[1]!.reason).toMatch(/no sessions dir at /);
  });
});
