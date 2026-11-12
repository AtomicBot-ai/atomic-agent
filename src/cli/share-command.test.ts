import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "../session/index.js";
import {
  parseShareArgs,
  resolveShareSession,
  shareCommand,
  type ShareDeps,
  type ShareSessionStore,
} from "./share-command.js";

function summary(id: string, workingDir: string, updatedAt: number): SessionSummary {
  return {
    id,
    workingDir,
    status: "idle",
    createdAt: updatedAt,
    updatedAt,
    turnCount: 2,
    stepCount: 1,
    firstPrompt: "hi",
    title: null,
  } as SessionSummary;
}

function fakeStore(
  rows: SessionSummary[],
  lines: { kind: "user" | "assistant_reply"; text: string }[] = [],
): ShareSessionStore & { close: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn((id: string) => {
      const row = rows.find((r) => r.id === id);
      return row
        ? ({ id, workingDir: row.workingDir, metadata: { title: "Cart bug" } } as never)
        : null;
    }),
    listSummaryPage: vi.fn(() => rows),
    listChatLines: vi.fn(() => lines),
    close: vi.fn(),
  };
}

const LINES = [
  { kind: "user" as const, text: "why does /Users/nadya/shop/src/cart.ts crash? key sk-ant-abcdefghijklmnopqrstuvwxyz0123" },
  { kind: "assistant_reply" as const, text: "Fixed it in src/cart.ts." },
];

function harness(extra: Partial<ShareDeps> = {}) {
  const written: { file: string; content: string }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const store = fakeStore([summary("s-abc123", "/Users/nadya/shop", 2)], LINES);
  const deps: ShareDeps = {
    openStore: () => store,
    stateDir: () => "/state",
    cwd: () => "/Users/nadya/shop",
    homeDir: () => "/Users/nadya",
    now: () => new Date("2026-11-12T10:00:00Z"),
    writeFile: (file, content) => written.push({ file, content }),
    isTTY: () => true,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ...extra,
  };
  return { deps, written, out, err, store };
}

describe("parseShareArgs", () => {
  it("defaults to the latest chat, no upload", () => {
    expect(parseShareArgs([])).toEqual({ session: "latest", format: null, out: null, gist: false, json: false });
  });

  it("reads every option", () => {
    expect(parseShareArgs(["--session", "s-1", "--format", "md", "--out", "a.md", "--gist"])).toEqual({
      session: "s-1",
      format: "md",
      out: "a.md",
      gist: true,
      json: false,
    });
  });

  it("refuses bad input", () => {
    expect(parseShareArgs(["--format", "pdf"])).toHaveProperty("error");
    expect(parseShareArgs(["--session"])).toHaveProperty("error");
    expect(parseShareArgs(["--public"])).toHaveProperty("error");
    expect(parseShareArgs(["--gist", "--json"])).toHaveProperty("error");
  });
});

describe("resolveShareSession", () => {
  const rows = [summary("s-aaa1", "/other", 3), summary("s-bbb1", "/here", 2), summary("s-aaa2", "/here", 1)];

  it("latest prefers the newest chat in this folder", () => {
    expect(resolveShareSession(fakeStore(rows), "latest", "/here")).toEqual({ id: "s-bbb1" });
    expect(resolveShareSession(fakeStore(rows), "latest", "/nowhere")).toEqual({ id: "s-aaa1" });
    expect(resolveShareSession(fakeStore([]), "latest", "/here")).toHaveProperty("error");
  });

  it("takes an exact id or a unique prefix", () => {
    expect(resolveShareSession(fakeStore(rows), "s-aaa2", "/")).toEqual({ id: "s-aaa2" });
    expect(resolveShareSession(fakeStore(rows), "s-bb", "/")).toEqual({ id: "s-bbb1" });
    expect(resolveShareSession(fakeStore(rows), "s-aa", "/")).toEqual({
      error: "s-aa matches more than one chat; give more of the id",
    });
    expect(resolveShareSession(fakeStore(rows), "s-zz", "/")).toEqual({ error: "no chat with id s-zz" });
  });
});

describe("shareCommand", () => {
  it("writes a redacted HTML file and uploads nothing by default", async () => {
    const upload = vi.fn();
    const h = harness({ upload });
    expect(await shareCommand([], h.deps)).toBe(0);
    expect(h.written).toHaveLength(1);
    const { file, content } = h.written[0]!;
    expect(file).toBe("/state/shared-chats/chat-s-abc123.html");
    expect(content).toContain("&lt;project&gt;/src/cart.ts");
    expect(content).not.toContain("/Users/nadya");
    expect(content).not.toContain("sk-ant-abcdefghijklmnop");
    expect(content).toContain("<title>Cart bug</title>");
    expect(upload).not.toHaveBeenCalled();
    expect(h.store.close).toHaveBeenCalled();
  });

  it("asks before uploading and uploads nothing on anything but yes", async () => {
    for (const answer of ["", "n", "no", "sure"]) {
      const upload = vi.fn();
      const h = harness({ upload, ask: async () => answer });
      expect(await shareCommand(["--gist"], h.deps)).toBe(0);
      expect(upload).not.toHaveBeenCalled();
      expect(h.err.join("")).toContain("About to upload /state/shared-chats/chat-s-abc123.md");
    }
  });

  it("uploads the written file as a secret gist after a yes", async () => {
    const upload = vi.fn(async () => ({ ok: true as const, url: "https://gist.github.com/u/abc" }));
    const ask = vi.fn(async () => "y");
    const h = harness({ upload, ask });
    expect(await shareCommand(["--gist"], h.deps)).toBe(0);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("/state/shared-chats/chat-s-abc123.md", "Atomic Agent chat: Cart bug");
    expect(h.written[0]!.content.startsWith("# Cart bug")).toBe(true);
    expect(h.out.join("")).toContain("https://gist.github.com/u/abc");
  });

  it("never uploads without a terminal to ask in", async () => {
    const upload = vi.fn();
    const ask = vi.fn();
    const h = harness({ upload, ask, isTTY: () => false });
    expect(await shareCommand(["--gist"], h.deps)).toBe(1);
    expect(ask).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(h.written).toHaveLength(1);
  });

  it("reports a failed upload", async () => {
    const h = harness({
      ask: async () => "yes",
      upload: async () => ({ ok: false as const, error: "gh is not installed" }),
    });
    expect(await shareCommand(["--gist"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("Not uploaded: gh is not installed");
  });

  it("prints a machine summary with --json", async () => {
    const h = harness();
    expect(await shareCommand(["--json", "--out", "chat.html"], h.deps)).toBe(0);
    const printed = JSON.parse(h.out.join(""));
    expect(printed).toMatchObject({
      ok: true,
      file: "/Users/nadya/shop/chat.html",
      sessionId: "s-abc123",
      format: "html",
      messages: 2,
    });
    expect(printed.removed.secrets).toBeGreaterThanOrEqual(1);
  });

  it("fails on a chat with no messages", async () => {
    const store = fakeStore([summary("s-empty", "/Users/nadya/shop", 1)], []);
    const h = harness({ openStore: () => store });
    expect(await shareCommand([], h.deps)).toBe(1);
    expect(h.written).toHaveLength(0);
  });
});
