import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chatLinesOf,
  groundingTextsOf,
  nameGroundingAcrossSessions,
  sessionGroundingSource,
  verifyProfileNameFacts,
  type ChatLine,
  type SessionTranscriptReader,
} from "./name-grounding.js";
import { ProfileStore } from "./profile-store.js";

interface FakeSession {
  id: string;
  updatedAt: number;
  lines: ChatLine[];
}

/** Newest first, paged by `(updatedAt, id)` like `SessionStore`. */
function fakeReader(sessions: FakeSession[]): SessionTranscriptReader & {
  chatLineReads: string[];
} {
  const sorted = [...sessions].sort((a, b) =>
    b.updatedAt !== a.updatedAt ? b.updatedAt - a.updatedAt : b.id.localeCompare(a.id),
  );
  const chatLineReads: string[] = [];
  return {
    chatLineReads,
    listSummaryPage({ limit, after }) {
      const start =
        after === undefined
          ? 0
          : sorted.findIndex(
              (s) =>
                s.updatedAt < after.updatedAt ||
                (s.updatedAt === after.updatedAt && s.id < after.id),
            );
      if (start < 0) return [];
      return sorted.slice(start, start + limit).map((s) => ({ id: s.id, updatedAt: s.updatedAt }));
    },
    listChatLines(id) {
      chatLineReads.push(id);
      return sorted.find((s) => s.id === id)?.lines ?? [];
    },
  };
}

const user = (text: string): ChatLine => ({ kind: "user", text });
const reply = (text: string): ChatLine => ({ kind: "assistant_reply", text });

/** The field case: 56 sessions, none of which carries the name «Анна». */
function nadyaSessions(): FakeSession[] {
  const out: FakeSession[] = [];
  for (let i = 0; i < 56; i += 1) {
    out.push({
      id: `s${String(i).padStart(2, "0")}`,
      updatedAt: 1_000 + i,
      lines: [user(`сделай макет для блока ${i}`), reply("Привет, Анна! Готово.")],
    });
  }
  out[3]!.lines.push(user("Меня зовут Надя, кстати"));
  return out;
}

describe("groundingTextsOf", () => {
  it("keeps the user's messages and never the assistant's", () => {
    expect(groundingTextsOf([user("hi"), reply("Привет, Анна!"), user("thanks")])).toEqual([
      "hi",
      "thanks",
    ]);
  });
});

describe("chatLinesOf", () => {
  it("projects a live transcript like listChatLines does", () => {
    expect(
      chatLinesOf([
        { kind: "user", text: "Меня зовут Надя" },
        { kind: "assistant_tool_call" },
        { kind: "tool_result", text: "Анна" },
        { kind: "assistant_reply", text: "one moment", progressNote: true },
        { kind: "assistant_reply", text: "Привет, Надя!" },
      ]),
    ).toEqual([
      { kind: "user", text: "Меня зовут Надя" },
      { kind: "assistant_reply", text: "Привет, Надя!" },
    ]);
  });
});

describe("sessionGroundingSource", () => {
  it("walks every session newest first across pages, and stops at `since`", async () => {
    const reader = fakeReader(nadyaSessions());
    const all: number[] = [];
    for await (const c of sessionGroundingSource(reader, 10)()) all.push(c.updatedAt);
    expect(all).toHaveLength(56);
    expect(all[0]).toBe(1_055);
    expect(all.at(-1)).toBe(1_000);

    const recent: number[] = [];
    for await (const c of sessionGroundingSource(reader, 10)({ since: 1_050 })) {
      recent.push(c.updatedAt);
    }
    expect(recent).toEqual([1_055, 1_054, 1_053, 1_052, 1_051]);
  });
});

describe("nameGroundingAcrossSessions", () => {
  it("grounds a name the user gave in another session; not one they never gave", async () => {
    const source = sessionGroundingSource(fakeReader(nadyaSessions()), 10);
    expect(await nameGroundingAcrossSessions("Надя", source)).toBe("grounded");
    expect(await nameGroundingAcrossSessions("Nadya", source)).toBe("grounded");
    // The assistant greeting her as Анна in every session vouches for nothing.
    expect(await nameGroundingAcrossSessions("Анна", source)).toBe("ungrounded");
  });
});

describe("verifyProfileNameFacts", () => {
  let tmp: string;
  let store: ProfileStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-name-check-"));
    store = new ProfileStore({ dbFile: join(tmp, "memory.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ATO-199: marks the invented «Анна» ungrounded, keeps it, and keeps it out of the prompt", async () => {
    // Rows an older build wrote: no verdict.
    store.set("name", "Анна", 500);
    store.set("first_name", "Надя", 500);
    store.set("timezone", "Europe/Moscow", 500);
    const info: Array<Record<string, unknown>> = [];
    const report = await verifyProfileNameFacts({
      store,
      source: sessionGroundingSource(fakeReader(nadyaSessions()), 10),
      now: () => 2_000,
      logger: {
        info: (_msg: string, ctx: Record<string, unknown>) => info.push(ctx),
      } as never,
    });
    expect(report).toEqual({ checked: 2, grounded: 1, ungrounded: 1, unverifiable: 0 });
    expect(store.get("name")).toMatchObject({ value: "Анна", nameGrounding: "ungrounded" });
    expect(store.get("first_name")?.nameGrounding).toBe("grounded");
    expect(store.listForPrompt().map((f) => f.key)).toEqual(["first_name", "timezone"]);
    expect(store.list().map((f) => f.key)).toContain("name");
    // Counts only — never a key or a value.
    expect(info).toHaveLength(1);
    expect(JSON.stringify(info)).not.toMatch(/Анна|Надя|first_name/);
  });

  it("checks a fact once, then only re-checks an ungrounded one against newer sessions", async () => {
    store.set("name", "Анна", 500);
    const sessions = nadyaSessions();
    const reader = fakeReader(sessions);
    await verifyProfileNameFacts({
      store,
      source: sessionGroundingSource(reader, 10),
      now: () => 2_000,
    });
    expect(reader.chatLineReads).toHaveLength(56);

    // Nothing new: the re-check reads no session at all.
    reader.chatLineReads.length = 0;
    await verifyProfileNameFacts({
      store,
      source: sessionGroundingSource(reader, 10),
      now: () => 3_000,
    });
    expect(reader.chatLineReads).toEqual([]);
    expect(store.get("name")?.nameGrounding).toBe("ungrounded");

    // The user says the name in a newer session: picked up next start.
    const later = fakeReader([
      ...sessions,
      { id: "new", updatedAt: 3_500, lines: [user("Вообще-то меня зовут Анна")] },
    ]);
    await verifyProfileNameFacts({
      store,
      source: sessionGroundingSource(later, 10),
      now: () => 4_000,
    });
    expect(later.chatLineReads).toEqual(["new"]);
    expect(store.get("name")?.nameGrounding).toBe("grounded");
    expect(store.listForPrompt().map((f) => f.key)).toEqual(["name"]);
  });

  // Review finding: the walk yields, and memory.profile.set may confirm
  // the name meanwhile; the check must not write `ungrounded` over it.
  it("does not undo a confirmation recorded while the walk ran", async () => {
    const fact = store.set("name", "Анна", 500);
    const reader = fakeReader(nadyaSessions());
    const inner = sessionGroundingSource(reader, 10);
    let confirmedMidWalk = false;
    const source: typeof inner = async function* (options) {
      for await (const conversation of inner(options)) {
        if (!confirmedMidWalk) {
          store.markNameGrounding(fact.id, "grounded");
          confirmedMidWalk = true;
        }
        yield conversation;
      }
    };
    const report = await verifyProfileNameFacts({ store, source });
    expect(report.checked).toBe(0);
    expect(store.get("name")?.nameGrounding).toBe("grounded");
  });

  it("does nothing when no name needs a check", async () => {
    store.set("name", "Надя", { nameGrounding: "grounded" }, 500);
    const reader = fakeReader(nadyaSessions());
    const report = await verifyProfileNameFacts({
      store,
      source: sessionGroundingSource(reader, 10),
    });
    expect(report.checked).toBe(0);
    expect(reader.chatLineReads).toEqual([]);
  });
});
