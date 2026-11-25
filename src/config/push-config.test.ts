import { describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS, parseUserConfigFile } from "./config-schema.js";
import { configBranchKind } from "./config-shape.js";
import { parseDownloadNotifyChannel } from "./integration-config.js";
import {
  DEFAULT_PUSH_SERVER,
  createPushDefaults,
  isValidPushTopic,
  parsePushConfig,
} from "./push-config.js";

describe("notifications.push (ATO-1129)", () => {
  it("is off with no topic in an older file that has no block", () => {
    const parsed = parseUserConfigFile({ notifications: { downloads: { channel: "email" } } });
    expect(parsed.notifications.push).toEqual({
      enabled: false,
      server: DEFAULT_PUSH_SERVER,
      topic: null,
      tokenEnv: "NTFY_TOKEN",
    });
    expect(parsed.notifications.downloads.channel).toBe("email");
    expect(USER_CONFIG_DEFAULTS.notifications.push).toEqual(createPushDefaults());
  });

  it("round-trips a configured block and trims the server's trailing slash", () => {
    const parsed = parseUserConfigFile({
      notifications: {
        push: {
          enabled: true,
          server: "https://ntfy.example.com/",
          topic: "atag-AbC_123-xyz",
          tokenEnv: "MY_NTFY",
        },
      },
    });
    expect(parsed.notifications.push).toEqual({
      enabled: true,
      server: "https://ntfy.example.com",
      topic: "atag-AbC_123-xyz",
      tokenEnv: "MY_NTFY",
    });
  });

  it("reads a blank topic as none", () => {
    expect(parsePushConfig({ topic: "  " }, createPushDefaults).topic).toBeNull();
  });

  it.each([
    [{ server: "ftp://ntfy.sh" }, /notifications\.push\.server/],
    [{ server: "not a url" }, /notifications\.push\.server/],
    [{ server: "https://user:pass@ntfy.sh" }, /not in the URL/],
    [{ topic: "has space" }, /notifications\.push\.topic/],
    [{ topic: "a/b" }, /notifications\.push\.topic/],
    [{ topic: 42 }, /notifications\.push\.topic/],
    [{ enabled: "maybe" }, /notifications\.push\.enabled/],
  ])("rejects %j", (push, error) => {
    expect(() => parseUserConfigFile({ notifications: { push } })).toThrow(error);
  });

  it("accepts ntfy's topic alphabet and nothing longer than 64", () => {
    expect(isValidPushTopic("atag-abc_DEF-123")).toBe(true);
    expect(isValidPushTopic("x".repeat(64))).toBe(true);
    expect(isValidPushTopic("x".repeat(65))).toBe(false);
    expect(isValidPushTopic("")).toBe(false);
  });

  it("takes push as a download channel", () => {
    expect(parseDownloadNotifyChannel("push", "f")).toBe("push");
    expect(
      parseUserConfigFile({ notifications: { downloads: { channel: "push" } } })
        .notifications.downloads.channel,
    ).toBe("push");
  });

  it("is a fixed config block, so an older build keeps its keys", () => {
    expect(configBranchKind("notifications.push")).toBe("fixed");
  });
});
