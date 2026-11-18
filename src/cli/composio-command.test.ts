import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composioCommand, formatAccountsTable } from "./composio-command.js";
import type { ComposioAccount } from "../config/composio-accounts-config.js";
import type { ComposioConnectedAccount } from "../composio/index.js";

let dir: string;
let configPath: string;
let out: string;
let err: string;

function run(args: string[], listConnected?: () => Promise<ComposioConnectedAccount[]>) {
  return composioCommand(args, {
    configPath,
    write: (t) => { out += t; },
    writeErr: (t) => { err += t; },
    ...(listConnected ? { listConnected } : {}),
  });
}

function saved(): ComposioAccount[] {
  const tree = JSON.parse(readFileSync(configPath, "utf8")) as {
    composio: { accounts: ComposioAccount[] };
  };
  return tree.composio.accounts;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "composio-cmd-"));
  configPath = join(dir, "config.json");
  out = "";
  err = "";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("composio accounts add / default / remove", () => {
  it("saves an account and makes it the app's default with --default", async () => {
    expect(await run(["accounts", "add", "Gmail", "work", "ca_work", "--default"])).toBe(0);
    expect(saved()).toEqual([
      { toolkit: "gmail", alias: "work", connectedAccountId: "ca_work", isDefault: true },
    ]);
    expect(out).toContain("next time the agent starts");
  });

  it("moves the default between accounts of one app", async () => {
    await run(["accounts", "add", "gmail", "work", "ca_work", "--default"]);
    await run(["accounts", "add", "gmail", "home", "ca_home"]);
    expect(await run(["accounts", "default", "gmail", "home"])).toBe(0);
    expect(saved().map((a) => [a.alias, a.isDefault])).toEqual([
      ["work", false],
      ["home", true],
    ]);
    expect(await run(["accounts", "default", "gmail", "--clear"])).toBe(0);
    expect(saved().every((a) => !a.isDefault)).toBe(true);
  });

  it("removes one account and leaves the rest", async () => {
    await run(["accounts", "add", "gmail", "work", "ca_work"]);
    await run(["accounts", "add", "slack", "work", "ca_slack"]);
    expect(await run(["accounts", "remove", "gmail", "work"])).toBe(0);
    expect(saved().map((a) => a.toolkit)).toEqual(["slack"]);
  });

  it("refuses a bad name, a duplicate, or an unknown account with exit 1 and writes nothing", async () => {
    expect(await run(["accounts", "add", "gmail", "Work Mail", "ca_1"])).toBe(1);
    expect(err).toMatch(/alias must be/);
    await run(["accounts", "add", "gmail", "work", "ca_1"]);
    expect(await run(["accounts", "add", "gmail", "work", "ca_2"])).toBe(1);
    expect(await run(["accounts", "remove", "gmail", "nope"])).toBe(1);
    expect(await run(["accounts", "default", "gmail", "nope"])).toBe(1);
    expect(saved()).toHaveLength(1);
  });

  it("returns 2 on usage errors", async () => {
    expect(await run([])).toBe(2);
    expect(await run(["sessions"])).toBe(2);
    expect(await run(["accounts", "add", "gmail", "work"])).toBe(2);
    expect(await run(["accounts", "remove", "gmail"])).toBe(2);
    expect(await run(["accounts", "default", "gmail"])).toBe(2);
    expect(await run(["accounts", "default", "gmail", "work", "--clear"])).toBe(2);
    expect(await run(["accounts", "add", "gmail", "w", "ca_1", "--force"])).toBe(2);
    expect(await run(["accounts", "rename"])).toBe(2);
  });
});

describe("composio accounts list", () => {
  it("prints JSON with the saved list, empty on a fresh install", async () => {
    expect(await run(["accounts", "list", "--json"])).toBe(0);
    expect(JSON.parse(out)).toEqual({ accounts: [] });
  });

  it("adds Composio's signed-in accounts with --connected", async () => {
    await run(["accounts", "add", "gmail", "work", "ca_work", "--default"]);
    out = "";
    const connected: ComposioConnectedAccount[] = [
      { id: "ca_work", toolkit: "gmail", status: "ACTIVE", alias: null, displayName: "me@work.test", createdAt: null },
      { id: "ca_home", toolkit: "gmail", status: "ACTIVE", alias: null, displayName: "me@home.test", createdAt: null },
    ];
    expect(await run(["accounts", "list", "--connected", "--json"], async () => connected)).toBe(0);
    const parsed = JSON.parse(out) as { accounts: ComposioAccount[]; connected: ComposioConnectedAccount[] };
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.connected).toHaveLength(2);
  });

  it("exits 1 when Composio cannot be asked", async () => {
    const failing = async (): Promise<ComposioConnectedAccount[]> => {
      throw new Error("no Composio API key is set");
    };
    expect(await run(["accounts", "list", "--connected"], failing)).toBe(1);
    expect(err).toContain("no Composio API key");
  });
});

describe("formatAccountsTable", () => {
  it("marks the default and lists signed-in accounts that are not saved", () => {
    const text = formatAccountsTable(
      [{ toolkit: "gmail", alias: "work", connectedAccountId: "ca_work", isDefault: true }],
      [
        { id: "ca_work", toolkit: "gmail", status: "ACTIVE", alias: null, displayName: "me@work.test", createdAt: null },
        { id: "ca_home", toolkit: "gmail", status: "ACTIVE", alias: null, displayName: null, createdAt: null },
      ],
    );
    expect(text).toMatch(/^\* gmail\s+work\s+ca_work me@work\.test/m);
    expect(text).toContain("not saved");
    expect(text).toMatch(/gmail\s+ca_home/);
  });

  it("says what happens with no saved accounts", () => {
    expect(formatAccountsTable([])).toContain("no saved accounts");
  });
});
