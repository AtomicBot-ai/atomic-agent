import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillCommand } from "./skill.js";
import { resetConfigCache } from "../config/index.js";
import { browseHub, searchHub } from "../skills/hub/index.js";

// `skill browse` / `skill search` (skill.ts handleBrowse / handleSearch):
// only the GitHub-tap side is stubbed; ClawHub runs for real against a
// stubbed `fetch`.
vi.mock("../skills/hub/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/hub/index.js")>()),
  browseHub: vi.fn(async () => ({ entries: [], errors: [] })),
  searchHub: vi.fn(async () => ({ entries: [], errors: [] })),
}));

const TAP_ROW = {
  identifier: "o/r/x", name: "x", description: "tap row", version: "1.0.0",
  repo: "o/r", dir: "x", source: "github" as const,
};
const CLAW = {
  slug: "claw-one", ownerHandle: "me", displayName: "Claw One",
  summary: "claw row", stats: { downloads: 5 }, tags: { latest: "1.0.0" },
};
// Browse reads `items`, search reads `results`.
const CLAW_BODY = JSON.stringify({ items: [CLAW], results: [CLAW] });

describe("skill browse / search", () => {
  let stateDir: string;
  let stdout = "";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-skill-browse-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  /**
   * Run `args` with ClawHub's answer held until the taps have been asked
   * (300 ms at most): a command that waits for ClawHub before asking the
   * taps shows it in the order of events.
   */
  async function run(args: string[]): Promise<{ code: number; order: string[] }> {
    const order: string[] = [];
    let tapsAsked!: () => void;
    const asked = new Promise<void>((r) => { tapsAsked = r; });
    const taps = async () => {
      order.push("taps asked");
      tapsAsked();
      return { entries: [TAP_ROW], errors: [] };
    };
    // Set on both, for this run's own `order`: the command calls one of them.
    vi.mocked(browseHub).mockImplementation(taps);
    vi.mocked(searchHub).mockImplementation(taps);
    vi.stubGlobal("fetch", vi.fn(async () => {
      order.push("clawhub asked");
      await Promise.race([asked, new Promise((r) => setTimeout(r, 300))]);
      order.push("clawhub answered");
      return new Response(CLAW_BODY, { status: 200, headers: { "content-type": "application/json" } });
    }));
    const code = await skillCommand(args);
    return { code, order };
  }

  it("browse asks ClawHub and the taps side by side, ClawHub's rows first", async () => {
    const { code, order } = await run(["browse"]);
    expect(code).toBe(0);
    expect(order).toEqual(["clawhub asked", "taps asked", "clawhub answered"]);
    expect(stdout.split("\n").filter(Boolean)).toEqual([
      "[claw]\t@me/claw-one\t↓5\tclaw row",
      "[gh]\to/r/x\t-\ttap row",
    ]);
  });

  it("search asks ClawHub and the taps side by side, ClawHub's rows first", async () => {
    const { code, order } = await run(["search", "claw"]);
    expect(code).toBe(0);
    expect(order).toEqual(["clawhub asked", "taps asked", "clawhub answered"]);
    expect(stdout.split("\n").filter(Boolean)).toEqual([
      "[claw]\t@me/claw-one\t↓5\tclaw row",
      "[gh]\to/r/x\t-\ttap row",
    ]);
  });
});
