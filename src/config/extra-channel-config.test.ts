import { describe, expect, it } from "vitest";
import { ConfigValidationError } from "./config-validation-error.js";
import { USER_CONFIG_DEFAULTS, parseUserConfigFile } from "./config-schema.js";
import {
  cloneExtraChannelsConfig,
  isValidExtraChannelId,
  parseExtraChannelsConfig,
} from "./extra-channel-config.js";

describe("parseExtraChannelsConfig", () => {
  it("reads a missing block as no channels", () => {
    expect(parseExtraChannelsConfig(undefined)).toEqual({});
    expect(USER_CONFIG_DEFAULTS.channels).toEqual({});
  });

  it("fills defaults and keeps scalar options", () => {
    expect(
      parseExtraChannelsConfig({
        slack: { enabled: true, ownerIds: [" U1 ", "U1", "U2"], options: { threadReplies: true, limit: 3, mode: "socket" } },
        signal: {},
      }),
    ).toEqual({
      slack: { enabled: true, ownerIds: ["U1", "U2"], options: { threadReplies: true, limit: 3, mode: "socket" } },
      signal: { enabled: false, ownerIds: [], options: {} },
    });
  });

  it.each([
    [{ telegram: {} }, "channels.telegram"],
    [{ Slack: {} }, "channels.Slack"],
    [{ slack: [] }, "channels.slack"],
    [{ slack: { ownerIds: "U1" } }, "channels.slack.ownerIds"],
    [{ slack: { ownerIds: [""] } }, "channels.slack.ownerIds[0]"],
    [{ slack: { options: { nested: { a: 1 } } } }, "channels.slack.options.nested"],
    [{ slack: { options: { n: Number.NaN } } }, "channels.slack.options.n"],
    [{ slack: { enabled: "maybe" } }, "channels.slack.enabled"],
  ])("rejects %j at %s", (raw, field) => {
    try {
      parseExtraChannelsConfig(raw);
      throw new Error("expected a validation error");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).field).toBe(field);
    }
  });

  it("is part of the user config file", () => {
    const parsed = parseUserConfigFile({
      ...structuredClone(USER_CONFIG_DEFAULTS),
      channels: { matrix: { enabled: true, ownerIds: ["@me:example.org"] } },
    });
    expect(parsed.channels).toEqual({
      matrix: { enabled: true, ownerIds: ["@me:example.org"], options: {} },
    });
  });
});

describe("channel ids and copies", () => {
  it("accepts lower-case ids and refuses the built-in blocks", () => {
    expect(isValidExtraChannelId("google-chat")).toBe(true);
    expect(isValidExtraChannelId("discord")).toBe(false);
    expect(isValidExtraChannelId("9lives")).toBe(false);
  });

  it("deep-copies so the runtime never aliases the parsed file", () => {
    const source = { slack: { enabled: true, ownerIds: ["U1"], options: { a: 1 } } };
    const copy = cloneExtraChannelsConfig(source);
    copy.slack!.ownerIds.push("U2");
    copy.slack!.options.a = 2;
    expect(source.slack.ownerIds).toEqual(["U1"]);
    expect(source.slack.options.a).toBe(1);
  });
});
