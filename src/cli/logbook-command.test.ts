import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendLogbookEntry, listLogbookDays, readLogbookDay } from "../logbook/logbook-store.js";
import { readLogbookSettings } from "../logbook/logbook-settings.js";
import { logbookCommand } from "./logbook-command.js";

const NOW = new Date(2026, 10, 27, 16, 0);

function harness(platform: NodeJS.Platform = "darwin", tty: { isTty: boolean; answer?: boolean } = { isTty: false }) {
  const stateDir = mkdtempSync(join(tmpdir(), "atomic-logbook-cli-"));
  let out = "";
  let err = "";
  const asked: string[] = [];
  const run = (...args: string[]) =>
    logbookCommand(args, {
      stateDir,
      now: () => NOW,
      platform,
      isTty: tty.isTty,
      confirm: async (prompt) => {
        asked.push(prompt);
        return tty.answer ?? false;
      },
      write: (t) => {
        out += t;
      },
      writeErr: (t) => {
        err += t;
      },
    });
  return { stateDir, run, asked, out: () => out, err: () => err, reset: () => { out = ""; err = ""; } };
}

describe("atomic-agent logbook", () => {
  it("is off until start, and start says what it keeps and how to stop", async () => {
    const h = harness();
    expect(readLogbookSettings(h.stateDir).enabled).toBe(false);
    expect(await h.run("start", "--every", "10", "--keep", "7")).toBe(0);
    expect(readLogbookSettings(h.stateDir)).toMatchObject({ enabled: true, intervalMinutes: 10, retentionDays: 7 });
    expect(h.out()).toMatch(/local vision model/);
    expect(h.out()).toMatch(/logbook stop/);
    expect(await h.run("stop")).toBe(0);
    expect(readLogbookSettings(h.stateDir).enabled).toBe(false);
  });

  it("starts on Windows too, and refuses a system it cannot watch (ATO-2526)", async () => {
    const win = harness("win32");
    expect(await win.run("start")).toBe(0);
    expect(readLogbookSettings(win.stateDir).enabled).toBe(true);
    const other = harness("freebsd");
    expect(await other.run("start")).toBe(1);
    expect(readLogbookSettings(other.stateDir).enabled).toBe(false);
  });

  it("pauses and resumes", async () => {
    const h = harness();
    expect(await h.run("pause")).toBe(2);
    await h.run("start");
    expect(await h.run("pause", "30")).toBe(0);
    expect(readLogbookSettings(h.stateDir).pausedUntil).toBe(NOW.getTime() + 30 * 60_000);
    h.reset();
    await h.run("status");
    expect(h.out()).toMatch(/^Logbook: PAUSED until 16:30/);
    await h.run("resume");
    expect(readLogbookSettings(h.stateDir).pausedUntil).toBeNull();
  });

  it("shows a day and deletes notes by range, day or all", async () => {
    const h = harness();
    appendLogbookEntry(h.stateDir, { at: new Date(2026, 10, 26, 9, 0).toISOString(), app: "Mail", bundleId: null, text: "morning mail" });
    appendLogbookEntry(h.stateDir, { at: new Date(2026, 10, 26, 15, 0).toISOString(), app: "Code", bundleId: null, text: "afternoon code" });
    appendLogbookEntry(h.stateDir, { at: new Date(2026, 10, 27, 10, 0).toISOString(), app: "Notes", bundleId: null, text: "today" });
    await h.run("show", "yesterday", "--part", "afternoon");
    expect(h.out()).toBe("15:00  Code  afternoon code\n");
    expect(await h.run("clear", "--day", "yesterday", "--from", "12:00", "--to", "18:00")).toBe(0);
    expect(readLogbookDay(h.stateDir, "2026-11-26").map((e) => e.text)).toEqual(["morning mail"]);
    expect(await h.run("clear", "--day", "2026-11-26")).toBe(0);
    expect(listLogbookDays(h.stateDir)).toEqual(["2026-11-27"]);
    expect(await h.run("clear")).toBe(2);
    expect(await h.run("clear", "--all", "--yes")).toBe(0);
    expect(listLogbookDays(h.stateDir)).toEqual([]);
  });

  it("clear --all asks first in a terminal and keeps the notes on no (ATO-2770)", async () => {
    const no = harness("darwin", { isTty: true, answer: false });
    appendLogbookEntry(no.stateDir, { at: new Date(2026, 10, 26, 9, 0).toISOString(), app: "Mail", bundleId: null, text: "a" });
    appendLogbookEntry(no.stateDir, { at: new Date(2026, 10, 27, 9, 0).toISOString(), app: "Mail", bundleId: null, text: "b" });
    appendLogbookEntry(no.stateDir, { at: new Date(2026, 10, 27, 10, 0).toISOString(), app: "Mail", bundleId: null, text: "c" });
    expect(await no.run("clear", "--all")).toBe(0);
    expect(no.asked).toEqual(["Delete all 3 notes (2 days)? This cannot be undone. [y/N] "]);
    expect(no.out()).toBe("Nothing deleted.\n");
    expect(listLogbookDays(no.stateDir)).toEqual(["2026-11-26", "2026-11-27"]);

    const yes = harness("darwin", { isTty: true, answer: true });
    appendLogbookEntry(yes.stateDir, { at: new Date(2026, 10, 27, 9, 0).toISOString(), app: "Mail", bundleId: null, text: "a" });
    expect(await yes.run("clear", "--all")).toBe(0);
    expect(yes.asked).toHaveLength(1);
    expect(listLogbookDays(yes.stateDir)).toEqual([]);
  });

  it("clear --all without a terminal deletes nothing unless --yes is given", async () => {
    const h = harness();
    appendLogbookEntry(h.stateDir, { at: new Date(2026, 10, 27, 9, 0).toISOString(), app: "Mail", bundleId: null, text: "a" });
    expect(await h.run("clear", "--all")).toBe(1);
    expect(h.asked).toEqual([]);
    expect(h.err()).toContain("atomic-agent logbook clear --all --yes");
    expect(listLogbookDays(h.stateDir)).toEqual(["2026-11-27"]);
    expect(await h.run("clear", "--all", "--yes")).toBe(0);
    expect(h.asked).toEqual([]);
    expect(listLogbookDays(h.stateDir)).toEqual([]);
  });

  it("keeps an excluded-apps list", async () => {
    const h = harness();
    await h.run("exclude", "add", "Slack");
    await h.run("exclude", "add", "com.hnc.Discord");
    await h.run("exclude", "remove", "slack");
    expect(readLogbookSettings(h.stateDir).excludeApps).toEqual(["com.hnc.Discord"]);
  });

  it("prints the standup recipe filled for a day, with its link", async () => {
    const h = harness();
    expect(await h.run("standup", "--day", "today")).toBe(0);
    expect(h.out()).toContain('logbook.query with day "today"');
    expect(h.out()).toContain("atomicagent://recipe/open?");
  });

  it("rejects an unknown subcommand as a usage error", async () => {
    const h = harness();
    expect(await h.run("explode")).toBe(2);
    expect(h.err()).toMatch(/unknown subcommand/);
  });

  it("notes chosen apps by title only, and lists them (ATO-2526)", async () => {
    const h = harness();
    expect(await h.run("title-only", "add", "Mail")).toBe(0);
    expect(readLogbookSettings(h.stateDir).titleOnlyApps).toEqual(["Mail"]);
    h.reset();
    await h.run("title-only", "list");
    expect(h.out()).toBe("Mail\n");
    expect(await h.run("title-only", "remove", "mail")).toBe(0);
    expect(readLogbookSettings(h.stateDir).titleOnlyApps).toEqual([]);
    expect(await h.run("title-only", "rename", "x")).toBe(2);
  });

  it("refuses a 51st title-only app instead of dropping it while saying it was added", async () => {
    const h = harness();
    for (let i = 1; i <= 50; i += 1) expect(await h.run("title-only", "add", `App ${i}`)).toBe(0);
    h.reset();
    expect(await h.run("title-only", "add", "Foo")).toBe(2);
    expect(h.err()).toMatch(/at most 50/);
    expect(h.out()).not.toMatch(/Foo will be noted/);
    const apps = readLogbookSettings(h.stateDir).titleOnlyApps;
    expect(apps).toHaveLength(50);
    expect(apps).not.toContain("Foo");
    // Adding one already on the full list again is not a 51st.
    expect(await h.run("title-only", "add", "app 7")).toBe(0);
  });

  it("schedules the morning standup and turns it off (ATO-2526)", async () => {
    const h = harness();
    expect(await h.run("standup", "--every-morning", "09:15")).toBe(0);
    expect(readLogbookSettings(h.stateDir).standupAt).toBe("09:15");
    expect(h.out()).toMatch(/logbook start/);
    expect(await h.run("standup", "--every-morning", "9")).toBe(2);
    expect(await h.run("standup", "--off")).toBe(0);
    expect(readLogbookSettings(h.stateDir).standupAt).toBeNull();
  });
});
