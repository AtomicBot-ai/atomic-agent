import { describe, expect, it } from "vitest";

import {
  ComposioAccountError,
  addComposioAccount,
  composioSessionPins,
  composioSessionStamp,
  findComposioAccount,
  removeComposioAccount,
  setDefaultComposioAccount,
} from "./composio-accounts.js";
import type { ComposioAccount } from "../config/composio-accounts-config.js";

const WORK: ComposioAccount = {
  toolkit: "gmail",
  alias: "work",
  connectedAccountId: "ca_work",
  isDefault: true,
};
const HOME: ComposioAccount = {
  toolkit: "gmail",
  alias: "home",
  connectedAccountId: "ca_home",
  isDefault: false,
};

describe("addComposioAccount", () => {
  it("adds a second account for the same toolkit under a new alias", () => {
    const out = addComposioAccount([WORK], {
      toolkit: "Gmail",
      alias: "home",
      connectedAccountId: " ca_home ",
    });
    expect(out).toEqual([WORK, HOME]);
  });

  it("moves the default when the new account is added as default", () => {
    const out = addComposioAccount([WORK], {
      toolkit: "gmail",
      alias: "home",
      connectedAccountId: "ca_home",
      isDefault: true,
    });
    expect(out.map((a) => [a.alias, a.isDefault])).toEqual([
      ["work", false],
      ["home", true],
    ]);
  });

  it("refuses a duplicate alias, a reused account and a bad alias", () => {
    expect(() =>
      addComposioAccount([WORK], { toolkit: "gmail", alias: "work", connectedAccountId: "ca_x" }),
    ).toThrow(ComposioAccountError);
    expect(() =>
      addComposioAccount([WORK], { toolkit: "gmail", alias: "two", connectedAccountId: "ca_work" }),
    ).toThrow(/listed twice/);
    expect(() =>
      addComposioAccount([], { toolkit: "gmail", alias: "Work Mail", connectedAccountId: "ca_x" }),
    ).toThrow(/alias must be/);
  });

  it("does not mutate its input", () => {
    const input = [WORK];
    addComposioAccount(input, { toolkit: "gmail", alias: "home", connectedAccountId: "ca_home", isDefault: true });
    expect(input).toEqual([WORK]);
    expect(WORK.isDefault).toBe(true);
  });
});

describe("removeComposioAccount / setDefaultComposioAccount", () => {
  it("removes one alias and leaves the rest", () => {
    expect(removeComposioAccount([WORK, HOME], "gmail", "work")).toEqual([HOME]);
  });

  it("errors on an unknown alias instead of silently doing nothing", () => {
    expect(() => removeComposioAccount([WORK], "gmail", "nope")).toThrow(/no gmail account named "nope"/);
    expect(() => setDefaultComposioAccount([WORK], "gmail", "nope")).toThrow(ComposioAccountError);
  });

  it("switches the default within one toolkit only", () => {
    const gh: ComposioAccount = { toolkit: "github", alias: "work", connectedAccountId: "ca_gh", isDefault: true };
    const out = setDefaultComposioAccount([WORK, HOME, gh], "gmail", "home");
    expect(out.map((a) => `${a.toolkit}/${a.alias}=${a.isDefault}`)).toEqual([
      "gmail/work=false",
      "gmail/home=true",
      "github/work=true",
    ]);
  });

  it("clears a toolkit's default with null", () => {
    const out = setDefaultComposioAccount([WORK, HOME], "gmail", null);
    expect(out.every((a) => !a.isDefault)).toBe(true);
  });

  it("finds an account by toolkit and alias", () => {
    expect(findComposioAccount([WORK, HOME], "GMAIL", "home")).toEqual(HOME);
    expect(findComposioAccount([WORK], "github", "work")).toBeUndefined();
  });
});

describe("composioSessionPins / composioSessionStamp", () => {
  it("pins only defaults, keyed by toolkit in sorted order", () => {
    const gh: ComposioAccount = { toolkit: "github", alias: "me", connectedAccountId: "ca_gh", isDefault: true };
    const pins = composioSessionPins([WORK, HOME, gh]);
    expect(pins).toEqual({ github: ["ca_gh"], gmail: ["ca_work"] });
    expect(Object.keys(pins)).toEqual(["github", "gmail"]);
  });

  it("pins nothing for an empty list or a list without defaults", () => {
    expect(composioSessionPins([])).toEqual({});
    expect(composioSessionPins([HOME])).toEqual({});
  });

  it("stamps null with no pins and ties a stamp to the session id", () => {
    expect(composioSessionStamp("trs_a", {})).toBeNull();
    expect(composioSessionStamp("trs_a", { gmail: ["ca_work"], github: ["ca_gh"] })).toBe(
      "trs_a#github=ca_gh,gmail=ca_work",
    );
    expect(composioSessionStamp("trs_b", { gmail: ["ca_work"] })).not.toBe(
      composioSessionStamp("trs_a", { gmail: ["ca_work"] }),
    );
  });
});
