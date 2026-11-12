import { describe, expect, it } from "vitest";

import {
  composioAliasError,
  parseComposioAccounts,
} from "./composio-accounts-config.js";
import { parseUserConfigFile, USER_CONFIG_VERSION } from "./config-schema.js";

const WORK = {
  toolkit: "gmail",
  alias: "work",
  connectedAccountId: "ca_work",
  isDefault: true,
};

describe("composioAliasError", () => {
  it.each(["work", "home", "a", "work-2", "0", "x".repeat(32)])(
    "accepts %s",
    (alias) => {
      expect(composioAliasError(alias)).toBeUndefined();
    },
  );

  it.each(["", "Work", "-work", "work_1", "work mail", "x".repeat(33), "wörk"])(
    "rejects %j",
    (alias) => {
      expect(composioAliasError(alias)).toMatch(/alias/);
    },
  );

  it("rejects a non-string", () => {
    expect(composioAliasError(7)).toMatch(/string/);
  });
});

describe("parseComposioAccounts", () => {
  it("reads absent and null as an empty list", () => {
    expect(parseComposioAccounts(undefined, "f")).toEqual([]);
    expect(parseComposioAccounts(null, "f")).toEqual([]);
  });

  it("reads a valid list and defaults isDefault to false", () => {
    const out = parseComposioAccounts(
      [WORK, { toolkit: "gmail", alias: "home", connectedAccountId: "ca_home" }],
      "f",
    );
    expect(out).toEqual([
      WORK,
      { toolkit: "gmail", alias: "home", connectedAccountId: "ca_home", isDefault: false },
    ]);
  });

  it("allows the same alias on different toolkits", () => {
    expect(
      parseComposioAccounts(
        [WORK, { ...WORK, toolkit: "github", connectedAccountId: "ca_gh" }],
        "f",
      ),
    ).toHaveLength(2);
  });

  it("rejects a duplicate alias within one toolkit", () => {
    expect(() =>
      parseComposioAccounts(
        [WORK, { ...WORK, connectedAccountId: "ca_other", isDefault: false }],
        "composio.accounts",
      ),
    ).toThrow(/composio\.accounts.*"work" is used twice for gmail/);
  });

  it("rejects the same connected account listed twice", () => {
    expect(() =>
      parseComposioAccounts([WORK, { ...WORK, alias: "other", isDefault: false }], "f"),
    ).toThrow(/listed twice/);
  });

  it("rejects two defaults for one toolkit", () => {
    expect(() =>
      parseComposioAccounts(
        [WORK, { ...WORK, alias: "home", connectedAccountId: "ca_home" }],
        "f",
      ),
    ).toThrow(/more than one default/);
  });

  it("names the bad field of a malformed entry", () => {
    expect(() =>
      parseComposioAccounts([{ ...WORK, alias: "Bad Alias" }], "composio.accounts"),
    ).toThrow(/composio\.accounts\[0\]\.alias/);
    expect(() =>
      parseComposioAccounts([{ ...WORK, toolkit: "Gmail" }], "f"),
    ).toThrow(/f\[0\]\.toolkit/);
    expect(() =>
      parseComposioAccounts([{ ...WORK, connectedAccountId: "" }], "f"),
    ).toThrow(/f\[0\]\.connectedAccountId/);
    expect(() =>
      parseComposioAccounts([{ ...WORK, isDefault: "yes" }], "f"),
    ).toThrow(/f\[0\]\.isDefault/);
    expect(() => parseComposioAccounts({}, "f")).toThrow(/array/);
  });

  it("is wired into the user config file with inert defaults", () => {
    const empty = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(empty.composio.accounts).toEqual([]);
    expect(empty.composio.sessionPins).toBeNull();
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      composio: { accounts: [WORK], sessionPins: "trs_a#gmail=ca_work" },
    });
    expect(parsed.composio.accounts).toEqual([WORK]);
    expect(parsed.composio.sessionPins).toBe("trs_a#gmail=ca_work");
  });
});
