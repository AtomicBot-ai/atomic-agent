import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { runDiscordFork, threadName, type DiscordForkRef } from "./discord-fork-command.js";

function sourceSession(id: string): SessionState {
  const state = createEmptySessionState({
    id,
    workingDir: "/tmp/test",
    metadata: { discordChannel: true, discordChat: { channelId: "c1", guildId: "g1", label: "channel c1" } },
  });
  state.turns = [
    { kind: "user", text: "plan the trip", at: 1 },
    { kind: "assistant_reply", text: "Here is a plan.", at: 2 },
    { kind: "user", text: "make it cheaper", at: 3 },
    { kind: "assistant_reply", text: "Cheaper plan.", at: 4 },
  ];
  state.turnCount = 2;
  state.macroTurnStarts = [2, 4];
  return state;
}

function makeDeps(source: SessionState, createThread?: (channelId: string, name: string) => Promise<string>) {
  const sessions = new Map([[source.id, source]]);
  const saved: SessionState[] = [];
  const chats = new Map<string, { current: string | null; label?: string }>([["c1", { current: source.id }]]);
  const releaseApprovalSession = vi.fn();
  const api: { createThread?: ReturnType<typeof vi.fn> } = createThread
    ? { createThread: vi.fn(createThread) }
    : {};
  const deps = {
    runtime: {
      sessionStore: {
        load: (id: string) => sessions.get(id) ?? null,
        save: (state: SessionState) => {
          saved.push(state);
          sessions.set(state.id, state);
        },
      },
      turnController: { isBusy: () => false },
    } as never,
    api,
    sessionPointer: {
      get: (k: string) => chats.get(k) ?? { current: null },
      setCurrent: (k: string, id: string, label?: string) => {
        chats.set(k, { current: id, ...(label ? { label } : {}) });
      },
    } as never,
    logger: { info: vi.fn(), warn: vi.fn() },
    releaseApprovalSession,
  };
  return { deps, saved, chats, releaseApprovalSession };
}

const guild: DiscordForkRef = { channelId: "c1", guildId: "g1", isDm: false, label: "channel c1" };
const dm: DiscordForkRef = { channelId: "c1", guildId: undefined, isDm: true, label: "DM" };

describe("/fork on Discord (ATO-2456)", () => {
  it("in a guild channel, opens a thread mapped to a copy and leaves the source alone", async () => {
    const source = sourceSession("s-src");
    const before = structuredClone(source);
    const { deps, saved, chats, releaseApprovalSession } = makeDeps(source, async () => "t9");

    const out = await runDiscordFork(guild, deps);

    expect(deps.api.createThread).toHaveBeenCalledWith("c1", "plan the trip (fork)");
    expect(saved).toHaveLength(1);
    const fork = saved[0]!;
    expect(fork.id).not.toBe(source.id);
    expect(fork.turns).toEqual(source.turns);
    expect(fork.metadata.discordChat).toEqual({
      channelId: "t9",
      guildId: "g1",
      parentChannelId: "c1",
      label: "thread t9",
    });
    expect(chats.get("t9")?.current).toBe(fork.id);
    expect(chats.get("c1")?.current).toBe(source.id);
    expect(source).toEqual(before);
    expect(releaseApprovalSession).not.toHaveBeenCalled();
    expect(out.map((m) => m.channelId)).toEqual(["c1", "t9"]);
    expect(out[0]!.text).toContain("<#t9>");
    expect(out[1]!.text).toContain("s-src");
  });

  it("forks in place when Discord refuses the thread", async () => {
    const source = sourceSession("s-src");
    const { deps, saved, chats, releaseApprovalSession } = makeDeps(source, async () => {
      throw new Error("Discord returned HTTP 400 for POST /channels/c1/threads.");
    });

    const out = await runDiscordFork(guild, deps);

    expect(saved).toHaveLength(1);
    expect(chats.get("c1")?.current).toBe(saved[0]!.id);
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-src");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain("/switch s-src");
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("in a DM, never asks for a thread and moves the DM to the copy", async () => {
    const source = sourceSession("s-src");
    const { deps, saved, chats } = makeDeps(source, async () => "t9");

    await runDiscordFork(dm, deps);

    expect(deps.api.createThread).not.toHaveBeenCalled();
    expect(chats.get("c1")?.current).toBe(saved[0]!.id);
    expect(saved[0]!.metadata.discordChat).toEqual({ channelId: "c1", label: "DM" });
  });

  it("/fork 1 copies the chat up to the first question and its answer", async () => {
    const source = sourceSession("s-src");
    const { deps, saved } = makeDeps(source);

    await runDiscordFork(dm, deps, "1");

    expect(saved[0]!.turns.map((t) => t.kind === "user" || t.kind === "assistant_reply" ? t.text : t.kind)).toEqual([
      "plan the trip",
      "Here is a plan.",
    ]);
  });

  it("/fork with a number out of range lists the questions and saves nothing", async () => {
    const source = sourceSession("s-src");
    const { deps, saved } = makeDeps(source);

    const out = await runDiscordFork(dm, deps, "5");

    expect(saved).toHaveLength(0);
    expect(out[0]!.text).toContain("This chat has 2 questions");
    expect(out[0]!.text).toContain("2. make it cheaper");
  });

  it("cuts a long thread name to Discord's 100 characters", () => {
    expect(threadName("x".repeat(150))).toHaveLength(100);
    expect(threadName("  ")).toBe("Fork");
  });
});
