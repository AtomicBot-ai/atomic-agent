import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";
import type { ConversationTurn } from "./conversation-turn.js";

/**
 * ATO-1149 review: the first search after an upgrade backfills hundreds
 * of sessions. Writing that in one transaction held the write lock for
 * seconds, and a message appended meanwhile by another process (the
 * desktop and the terminal share one `sessions.sqlite`) failed with
 * SQLITE_BUSY. Now transcripts are read without the lock and the index is
 * written a few sessions per transaction.
 *
 * Handle A is a `SessionStore` here; handle B is a second process on the
 * same file appending a message to one session in a loop, the row write
 * `SessionStore.save` does. It has to be another process: better-sqlite3
 * is synchronous, so nothing in this one can run while A's search does.
 * B's busy timeout is 1 s, stricter than the store's 5 s default.
 */

const SESSIONS = 600;
const LINES_PER_SESSION = 40;
const B_BUSY_TIMEOUT_MS = 1000;

const WORDS = [
  "deploy", "staging", "budget", "invoice", "migration", "postgres", "release",
  "kubernetes", "hosting", "report", "customer", "pipeline", "review", "draft",
  "релиз", "бюджет", "сервер", "отчёт", "задача", "клиент",
];

function longText(seed: number): string {
  const out: string[] = [];
  for (let i = 0; out.join(" ").length < 800; i += 1) {
    out.push(`${WORDS[(seed * 7 + i * 13) % WORDS.length]}${(seed + i) % 97}`);
  }
  return out.join(" ");
}

const WRITER = `
const Database = require(process.env.BSQL_PATH);
const fs = require("node:fs");
const db = new Database(process.env.DB_FILE, { timeout: Number(process.env.BUSY_MS) });
db.pragma("journal_mode = WAL");
const append = db.prepare(
  "UPDATE sessions SET payload = json_insert(payload, '$.turns[#]', json(?)), updated_at = ? WHERE id = 'b-live'"
);
let busy = 0;
const okAt = [];
const other = [];
process.stdout.write("ready\\n");
const started = Date.now();
while (!fs.existsSync(process.env.STOP_FILE) && Date.now() - started < 170000) {
  try {
    const now = Date.now();
    const turn = JSON.stringify({ kind: "user", text: "appended " + okAt.length, at: now });
    if (append.run(turn, now).changes === 1) okAt.push(now);
  } catch (err) {
    if (err && err.code === "SQLITE_BUSY") busy += 1;
    else other.push(String(err && err.message));
  }
  const pause = Date.now();
  while (Date.now() - pause < 5) {}
}
db.close();
process.stdout.write(JSON.stringify({ busy, okAt, other }) + "\\n");
`;

interface WriterReport {
  busy: number;
  okAt: number[];
  other: string[];
}

describe("session search backfill and a concurrent writer", () => {
  let tmp: string;
  let file: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-sess-search-lock-"));
    file = join(tmp, "sessions.sqlite");
    store = new SessionStore({ dbFile: file });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "lets another handle append messages while the first search indexes 600 large sessions",
    async () => {
      for (let n = 0; n < SESSIONS; n += 1) {
        const turns: ConversationTurn[] = Array.from({ length: LINES_PER_SESSION }, (_, i) => ({
          kind: i % 2 === 0 ? ("user" as const) : ("assistant_reply" as const),
          text: longText(n * LINES_PER_SESSION + i),
          at: i + 1,
        }));
        store.save({ ...createEmptySessionState({ id: `seed-${n}`, workingDir: "/w" }), turns });
      }
      const live = createEmptySessionState({ id: "b-live", workingDir: "/w" });
      store.save({ ...live, turns: [{ kind: "user", text: "first", at: 1 }] });

      const stopFile = join(tmp, "stop");
      const child = spawn(process.execPath, ["-e", WRITER], {
        env: {
          ...process.env,
          BSQL_PATH: createRequire(import.meta.url).resolve("better-sqlite3"),
          DB_FILE: file,
          BUSY_MS: String(B_BUSY_TIMEOUT_MS),
          STOP_FILE: stopFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes("ready\n")) resolve();
        });
        child.on("exit", () => reject(new Error(`writer exited early: ${stderr}`)));
      });
      // Give B a head start so its loop is running before A takes the file.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const searchStarted = Date.now();
      const result = store.searchTranscripts({ query: "deploy" });
      const searchEnded = Date.now();

      writeFileSync(stopFile, "");
      expect(await exited).toBe(0);
      const lastLine = stdout.trim().split("\n").at(-1) ?? "{}";
      const report = JSON.parse(lastLine) as WriterReport;

      expect(report.other).toEqual([]);
      expect(report.busy).toBe(0);
      // B really wrote while A was indexing, not only before or after.
      const during = report.okAt.filter((at) => at >= searchStarted && at <= searchEnded);
      expect(during.length).toBeGreaterThan(0);
      // Every append landed in the row.
      expect(store.load("b-live")?.turns).toHaveLength(1 + report.okAt.length);
      // The search still found something, and left the rest for later.
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.pending).toBeGreaterThan(0);
    },
    180_000,
  );
});
