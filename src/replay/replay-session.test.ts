import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStablePrefix } from "../prompt/stable-prefix.js";
import { hashPrefix } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/index.js";
import { applyToolSearch } from "../tools/tool-search/index.js";

import { replaySession } from "./replay-session.js";

interface Fixture {
  tmp: string;
  path: string;
  sessionId: string;
  recordedHash: string;
}

function writeTrace(options: {
  recordedHash: string;
  otherHashForDrift?: string;
}): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "replay-session-"));
  const sessionId = "s-replay";
  const dir = join(tmp, "traces");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.ndjson`);
  const events = [
    {
      type: "session_started",
      seq: 0,
      sessionId,
      ts: 1,
      workingDir: "/work",
    },
    { type: "turn_started", seq: 1, sessionId, ts: 2, turnIndex: 0 },
    {
      type: "step_started",
      seq: 2,
      sessionId,
      ts: 3,
      turnIndex: 0,
      stepIndex: 0,
    },
    {
      type: "prompt_captured",
      seq: 3,
      sessionId,
      ts: 4,
      turnIndex: 0,
      stepIndex: 0,
      stablePrefixHash: options.recordedHash,
      tail: "### conversation\nuser: hi\n",
      tokens: { total: 100, stablePrefix: 80, tail: 20 },
      slotId: 0,
      cacheReused: false,
    },
    {
      type: "step_started",
      seq: 4,
      sessionId,
      ts: 5,
      turnIndex: 0,
      stepIndex: 1,
    },
    {
      type: "prompt_captured",
      seq: 5,
      sessionId,
      ts: 6,
      turnIndex: 0,
      stepIndex: 1,
      stablePrefixHash: options.otherHashForDrift ?? options.recordedHash,
      tail: "### conversation\nuser: hi\n",
      tokens: { total: 110, stablePrefix: 80, tail: 30 },
      slotId: 0,
      cacheReused: true,
    },
  ];
  writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return { tmp, path, sessionId, recordedHash: options.recordedHash };
}

function buildCurrentContext() {
  const capabilities = {
    platform: "linux" as NodeJS.Platform,
    arch: "x64",
    browserChannel: "chrome",
    workingDir: "/work",
    hasClipboard: true,
    hasWmctrl: false,
    hasNotifications: false,
  };
  return {
    capabilities,
    toolDescriptors: [
      { name: "reply", summary: "reply to user", argsSchema: "{text:string}" },
    ],
    skillCatalog: [],
    profile: PLAIN_INSTRUCT_PROFILE,
  };
}

describe("replaySession", () => {
  it("reports no drift when hashes match", async () => {
    const context = buildCurrentContext();
    const currentHash = hashPrefix(
      buildStablePrefix({
        toolDescriptors: context.toolDescriptors,
        capabilities: context.capabilities,
        skillCatalog: context.skillCatalog,
        reasoningSystemToken: context.profile.reasoningSystemToken,
      }),
    );
    const fx = writeTrace({ recordedHash: currentHash });
    try {
      const report = await replaySession({ path: fx.path, context });
      expect(report.sessionId).toBe(fx.sessionId);
      expect(report.workingDir).toBe("/work");
      expect(report.totalSteps).toBe(2);
      expect(report.driftCount).toBe(0);
      expect(report.steps.every((s) => s.drift === false)).toBe(true);
    } finally {
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("flags drift when the current stable prefix differs", async () => {
    const context = buildCurrentContext();
    const fx = writeTrace({
      recordedHash: "deadbeef".repeat(8),
      otherHashForDrift: "deadbeef".repeat(8),
    });
    try {
      const report = await replaySession({ path: fx.path, context });
      expect(report.driftCount).toBe(2);
      expect(
        report.steps.every((s) => s.recordedHash === "deadbeef".repeat(8)),
      ).toBe(true);
      expect(report.steps[0]!.currentHash).not.toBe("deadbeef".repeat(8));
      expect(report.steps.every((s) => s.matchedTransport === null)).toBe(true);
    } finally {
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("reports no drift for a native_tools-recorded trace when no transport is pinned", async () => {
    // Since issue #285 the stable prefix differs by construction between
    // the transports, and traces do not record which one served the
    // session. An unpinned replay must therefore accept a match against
    // either variant — otherwise every native-transport session (the
    // default on openai / subscription-cli providers) reports 100% false
    // drift.
    const context = buildCurrentContext();
    const nativeHash = hashPrefix(
      buildStablePrefix({
        toolDescriptors: context.toolDescriptors,
        capabilities: context.capabilities,
        skillCatalog: context.skillCatalog,
        reasoningSystemToken: context.profile.reasoningSystemToken,
        toolTransport: "native_tools",
      }),
    );
    const fx = writeTrace({ recordedHash: nativeHash });
    try {
      const report = await replaySession({ path: fx.path, context });
      expect(report.driftCount).toBe(0);
      expect(
        report.steps.every((s) => s.matchedTransport === "native_tools"),
      ).toBe(true);
      expect(report.steps.every((s) => s.currentHash === nativeHash)).toBe(
        true,
      );
    } finally {
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("a pinned transport restricts matching to that variant", async () => {
    const context = buildCurrentContext();
    const nativeHash = hashPrefix(
      buildStablePrefix({
        toolDescriptors: context.toolDescriptors,
        capabilities: context.capabilities,
        skillCatalog: context.skillCatalog,
        reasoningSystemToken: context.profile.reasoningSystemToken,
        toolTransport: "native_tools",
      }),
    );
    const fx = writeTrace({ recordedHash: nativeHash });
    try {
      const pinnedNative = await replaySession({
        path: fx.path,
        context: { ...context, toolTransport: "native_tools" },
      });
      expect(pinnedNative.driftCount).toBe(0);

      const pinnedGrammar = await replaySession({
        path: fx.path,
        context: { ...context, toolTransport: "grammar" },
      });
      expect(pinnedGrammar.driftCount).toBe(2);
      expect(
        pinnedGrammar.steps.every((s) => s.matchedTransport === null),
      ).toBe(true);
    } finally {
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
  it("reports no drift for a compact-scaffold trace unless the full scaffold is pinned", async () => {
    // ATO-1116: a session on a window of 64K or less runs the compact
    // scaffold by default. Traces do not record it, so the unpinned
    // replay tries both scaffolds for each transport.
    const context = buildCurrentContext();
    const compactHash = hashPrefix(
      buildStablePrefix({
        toolDescriptors: context.toolDescriptors,
        capabilities: context.capabilities,
        skillCatalog: context.skillCatalog,
        reasoningSystemToken: context.profile.reasoningSystemToken,
        toolTransport: "native_tools",
        compact: true,
      }),
    );
    const fx = writeTrace({ recordedHash: compactHash });
    try {
      const report = await replaySession({ path: fx.path, context });
      expect(report.driftCount).toBe(0);
      expect(report.steps.every((s) => s.matchedCompact === true)).toBe(true);
      expect(
        report.steps.every((s) => s.matchedTransport === "native_tools"),
      ).toBe(true);

      const pinnedFull = await replaySession({
        path: fx.path,
        context: { ...context, compact: false },
      });
      expect(pinnedFull.driftCount).toBe(2);
      expect(pinnedFull.steps.every((s) => s.matchedCompact === null)).toBe(true);
    } finally {
      rmSync(fx.tmp, { recursive: true, force: true });
    }
  });

  it("matches a trace recorded with search mode off or on (ATO-1335)", async () => {
    // The runtime mounts `tool.search` only in search mode, and traces do
    // not record the mode: the replay gets the full catalog and must try
    // the prefix with and without it.
    const base = buildCurrentContext();
    const context = {
      ...base,
      toolDescriptors: [
        ...base.toolDescriptors,
        { name: "os.git.show", summary: "show a commit", argsSchema: "{rev:string}" },
        { name: "tool.search", summary: "find a tool", argsSchema: "{query:string}" },
      ],
    };
    const hashWith = (toolSearch: boolean): string =>
      hashPrefix(
        buildStablePrefix({
          toolDescriptors: applyToolSearch(context.toolDescriptors, toolSearch),
          capabilities: context.capabilities,
          skillCatalog: context.skillCatalog,
          reasoningSystemToken: context.profile.reasoningSystemToken,
        }),
      );
    expect(hashWith(false)).not.toBe(hashWith(true));

    const off = writeTrace({ recordedHash: hashWith(false) });
    const on = writeTrace({ recordedHash: hashWith(true) });
    try {
      const offReport = await replaySession({ path: off.path, context });
      expect(offReport.driftCount).toBe(0);
      expect(offReport.steps.every((s) => s.matchedToolSearch === false)).toBe(true);

      const onReport = await replaySession({ path: on.path, context });
      expect(onReport.driftCount).toBe(0);
      expect(onReport.steps.every((s) => s.matchedToolSearch === true)).toBe(true);

      const pinnedOn = await replaySession({
        path: off.path,
        context: { ...context, toolSearch: true },
      });
      expect(pinnedOn.driftCount).toBe(2);
      expect(pinnedOn.steps.every((s) => s.matchedToolSearch === null)).toBe(true);
    } finally {
      rmSync(off.tmp, { recursive: true, force: true });
      rmSync(on.tmp, { recursive: true, force: true });
    }
  });
});
