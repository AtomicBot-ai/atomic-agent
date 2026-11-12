import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearComposioSession,
  persistComposioAccounts,
  persistComposioSession,
} from "./persist-composio-session.js";
import type { ComposioAccount } from "../config/composio-accounts-config.js";

const WORK: ComposioAccount = {
  toolkit: "gmail",
  alias: "work",
  connectedAccountId: "ca_work",
  isDefault: true,
};

let dir: string;
let configPath: string;

function readComposio(): Record<string, unknown> {
  const tree = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  return tree.composio as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "composio-persist-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("persistComposioSession", () => {
  it("writes the session with its pin stamp, and null when unpinned", () => {
    persistComposioSession(configPath, {
      userId: "u",
      sessionId: "trs_a",
      mcpUrl: "https://example.test/mcp",
      sessionPins: "trs_a#gmail=ca_work",
    });
    expect(readComposio()).toMatchObject({
      userId: "u",
      sessionId: "trs_a",
      sessionPins: "trs_a#gmail=ca_work",
    });
    persistComposioSession(configPath, {
      userId: "u",
      sessionId: "trs_b",
      mcpUrl: "https://example.test/mcp",
    });
    expect(readComposio().sessionPins).toBeNull();
  });

  it("clears the stamp together with the session, keeping accounts", () => {
    persistComposioAccounts(configPath, [WORK]);
    persistComposioSession(configPath, {
      userId: "u",
      sessionId: "trs_a",
      mcpUrl: "https://example.test/mcp",
      sessionPins: "trs_a#gmail=ca_work",
    });
    clearComposioSession(configPath);
    expect(readComposio()).toMatchObject({
      userId: "u",
      sessionId: null,
      mcpUrl: null,
      sessionPins: null,
      accounts: [WORK],
    });
  });
});

describe("persistComposioAccounts", () => {
  it("writes the list and leaves the cached session in place", () => {
    persistComposioSession(configPath, {
      userId: "u",
      sessionId: "trs_a",
      mcpUrl: "https://example.test/mcp",
    });
    persistComposioAccounts(configPath, [WORK]);
    expect(readComposio()).toMatchObject({
      sessionId: "trs_a",
      accounts: [WORK],
    });
  });

  it("refuses an invalid list before writing anything", () => {
    persistComposioAccounts(configPath, [WORK]);
    expect(() =>
      persistComposioAccounts(configPath, [
        WORK,
        { ...WORK, connectedAccountId: "ca_other", isDefault: false },
      ]),
    ).toThrow(/used twice/);
    expect(readComposio().accounts).toEqual([WORK]);
  });
});
