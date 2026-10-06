import { describe, expect, it } from "vitest";
import {
  createNotificationsDefaults,
  createAtomicMailDefaults,
  createGitDefaults,
  createComposioDefaults,
  parseNotificationsConfig,
  parseAtomicMailConfig,
  parseGitConfig,
  parseComposioConfig,
  parseDownloadNotifyChannel,
} from "./integration-config.js";
import {
  ConfigValidationError,
  USER_CONFIG_DEFAULTS,
  parseUserConfigFile,
  parseDownloadNotifyChannel as rootDownloadChannel,
} from "./config-schema.js";

function captureError(run: () => unknown): ConfigValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error("Expected a configuration validation error");
}

const pending = {
  email: " operator ",
  codeHash: " opaque-hash ",
  expiresAt: " deferred-date-validation ",
  attempts: 2.9,
};

describe("integration configuration ownership", () => {
  it("preserves the public download-parser identity and whole-file assembly", () => {
    expect(rootDownloadChannel).toBe(parseDownloadNotifyChannel);
    const parsed = parseUserConfigFile({});
    expect(parsed.notifications).toEqual(createNotificationsDefaults());
    expect(parsed.atomicMail).toEqual(createAtomicMailDefaults());
    expect(parsed.git).toEqual(createGitDefaults());
    expect(parsed.composio).toEqual(createComposioDefaults());
  });

  it("creates fresh mutable defaults at every owned object depth", () => {
    const notices = createNotificationsDefaults();
    expect(notices).not.toBe(createNotificationsDefaults());
    expect(notices.downloads).not.toBe(createNotificationsDefaults().downloads);
    notices.downloads.channel = "email";
    expect(createNotificationsDefaults().downloads.channel).toBeNull();
    const mail = createAtomicMailDefaults();
    mail.address = "changed";
    expect(createAtomicMailDefaults().address).toBeNull();
    expect(createGitDefaults()).not.toBe(createGitDefaults());
    expect(createComposioDefaults()).not.toBe(createComposioDefaults());
    expect(Object.keys(createComposioDefaults())).toEqual([
      "enabled", "apiKeyEnv", "userId", "sessionId", "mcpUrl",
    ]);
  });

  it("keeps direct null clearing distinct from the composing default fallback", () => {
    const saved = USER_CONFIG_DEFAULTS.notifications;
    try {
      USER_CONFIG_DEFAULTS.notifications = { downloads: { channel: "email" } };
      expect(parseDownloadNotifyChannel(null, "channel")).toBeNull();
      expect(parseDownloadNotifyChannel(undefined, "channel")).toBeNull();
      expect(parseNotificationsConfig({ channel: null }, () => USER_CONFIG_DEFAULTS.notifications))
        .toEqual({ downloads: { channel: "email" } });
      expect(parseUserConfigFile({ notifications: { downloads: { channel: null } } }).notifications)
        .toEqual({ downloads: { channel: "email" } });
      expect(parseUserConfigFile({ notifications: { downloads: { channel: "off" } } }).notifications)
        .toEqual({ downloads: { channel: "off" } });
    } finally {
      USER_CONFIG_DEFAULTS.notifications = saved;
    }
  });

  it("looks up the current notification default after the raw getter", () => {
    let defaults = createNotificationsDefaults();
    const events: string[] = [];
    const parsed = parseNotificationsConfig({
      get channel() {
        events.push("raw.channel");
        defaults = { downloads: { channel: "discord" } };
        return undefined;
      },
    }, () => {
      events.push("defaults");
      return defaults;
    });
    expect(events).toEqual(["raw.channel", "defaults"]);
    expect(parsed).toEqual({ downloads: { channel: "discord" } });
  });

  it("keeps the notifications downloads reference prepared before late TUI validation", () => {
    const early = { channel: "email" };
    const input = {
      notifications: { downloads: early },
      tui: {
        get theme() {
          input.notifications.downloads = { channel: "off" };
          return "auto";
        },
      },
    };
    expect(parseUserConfigFile(input).notifications.downloads.channel).toBe("email");
    expect(input.notifications.downloads.channel).toBe("off");
  });

  it("normalizes mail from raw input even after replacing all mail defaults", () => {
    const saved = USER_CONFIG_DEFAULTS.atomicMail;
    try {
      USER_CONFIG_DEFAULTS.atomicMail = {
        address: "default-address", accountId: "default-account",
        ownerEmail: "default-owner", ownerVerifiedAt: "default-stamp",
        pendingVerification: { email: "default", codeHash: "default", expiresAt: "default", attempts: 9 },
      };
      expect(parseUserConfigFile({}).atomicMail).toEqual(createAtomicMailDefaults());
      expect(parseAtomicMailConfig({})).toEqual(createAtomicMailDefaults());
      expect(parseAtomicMailConfig({ address: " ", accountId: null, ownerEmail: " operator ", ownerVerifiedAt: " deferred-date " }))
        .toEqual({ address: null, accountId: null, ownerEmail: "operator", ownerVerifiedAt: "deferred-date", pendingVerification: null });
    } finally {
      USER_CONFIG_DEFAULTS.atomicMail = saved;
    }
  });

  it("defers mail identity/hash/date policy and preserves numeric attempt normalization", () => {
    const parsed = parseAtomicMailConfig({ pendingVerification: pending });
    expect(parsed.pendingVerification).toEqual({
      email: "operator", codeHash: "opaque-hash", expiresAt: "deferred-date-validation", attempts: 2,
    });
    expect(parsed.pendingVerification).not.toBe(pending);
    expect(parseAtomicMailConfig({ pendingVerification: { ...pending, attempts: Infinity } }).pendingVerification?.attempts)
      .toBe(Infinity);
    for (const attempts of [NaN, -1, "3"]) {
      expect(parseAtomicMailConfig({ pendingVerification: { ...pending, attempts } }).pendingVerification?.attempts)
        .toBe(0);
    }
  });

  it("keeps repeated pending attempt getter reads and their order", () => {
    const events: string[] = [];
    let reads = 0;
    const parsed = parseAtomicMailConfig({
      pendingVerification: {
        get email() { events.push("email"); return "operator"; },
        get codeHash() { events.push("codeHash"); return "opaque"; },
        get expiresAt() { events.push("expiresAt"); return "later"; },
        get attempts() { events.push("attempts"); return [1, 1.9, 2.9][reads++]; },
      },
    });
    expect(events).toEqual(["email", "codeHash", "expiresAt", "attempts", "attempts", "attempts"]);
    expect(parsed.pendingVerification?.attempts).toBe(2);
  });

  it("reports the same pending-verification field and error before later integration fields", () => {
    const error = captureError(() => parseAtomicMailConfig({ pendingVerification: { email: "operator" } }));
    expect(error.field).toBe("atomicMail.pendingVerification");
    expect(error.reason).toBe("expected email, codeHash and expiresAt");
    expect(error.message).toBe("invalid config: atomicMail.pendingVerification: expected email, codeHash and expiresAt");
    expect(captureError(() => parseUserConfigFile({
      atomicMail: { pendingVerification: { email: "operator" } },
      git: { remoteSync: "invalid" },
      composio: { enabled: "invalid" },
    })).field).toBe("atomicMail.pendingVerification");
  });

  it("preserves notifications, mail, git and composio error precedence", () => {
    const noticeError = captureError(() => parseUserConfigFile({
      notifications: { downloads: { channel: "pager" } },
      atomicMail: { address: 1 },
      git: { remoteSync: "invalid" },
    }));
    expect(noticeError.field).toBe("notifications.downloads.channel");
    const gitError = captureError(() => parseUserConfigFile({
      git: { remoteSync: "invalid" }, composio: { enabled: "invalid" },
    }));
    expect(gitError.field).toBe("git.remoteSync");
  });

  it("uses composio scalar defaults without supplying nullable cache defaults", () => {
    const defaults = {
      ...createComposioDefaults(), enabled: false, apiKeyEnv: " CUSTOM_KEY ",
      userId: "default-user", sessionId: "default-session", mcpUrl: "default-url",
    };
    expect(parseComposioConfig({}, () => defaults)).toEqual({
      enabled: false, apiKeyEnv: " CUSTOM_KEY ", userId: null, sessionId: null, mcpUrl: null,
    });
    expect(parseComposioConfig({ userId: " install ", sessionId: " ", mcpUrl: " deferred endpoint " }, () => defaults))
      .toEqual({ enabled: false, apiKeyEnv: " CUSTOM_KEY ", userId: "install", sessionId: null, mcpUrl: "deferred endpoint" });
  });

  it("reads composio defaults per expression after within-call replacement", () => {
    let defaults = createComposioDefaults();
    const events: string[] = [];
    const parsed = parseComposioConfig({
      get enabled() { events.push("raw.enabled"); return undefined; },
      get apiKeyEnv() {
        events.push("raw.apiKeyEnv");
        defaults = { ...createComposioDefaults(), apiKeyEnv: "REPLACED_KEY" };
        return undefined;
      },
    }, () => {
      events.push("defaults");
      return defaults;
    });
    expect(events).toEqual(["raw.enabled", "defaults", "raw.apiKeyEnv", "defaults"]);
    expect(parsed.apiKeyEnv).toBe("REPLACED_KEY");
    expect(parsed.enabled).toBe(true);
  });

  it("does not skip composio validation when disabled or look up unused defaults", () => {
    let calls = 0;
    const defaults = () => { calls++; return createComposioDefaults(); };
    expect(captureError(() => parseComposioConfig({ enabled: false, apiKeyEnv: "" }, defaults)).field)
      .toBe("composio.apiKeyEnv");
    expect(calls).toBe(0);
    expect(parseGitConfig({ remoteSync: true }, () => {
      throw new Error("Explicit value must not read the default");
    })).toEqual({ remoteSync: true });
  });

  it("keeps normalized object freshness and key order without adding unknown nested fields", () => {
    const raw = { ...pending, extra: "discard" };
    const a = parseAtomicMailConfig({ pendingVerification: raw, extra: "discard" });
    const b = parseAtomicMailConfig({ pendingVerification: raw });
    expect(a).not.toBe(b);
    expect(a.pendingVerification).not.toBe(b.pendingVerification);
    expect(Object.keys(a)).toEqual(["address", "accountId", "ownerEmail", "ownerVerifiedAt", "pendingVerification"]);
    expect(Object.keys(a.pendingVerification ?? {})).toEqual(["email", "codeHash", "expiresAt", "attempts"]);
    expect(a).not.toHaveProperty("extra");
    expect(a.pendingVerification).not.toHaveProperty("extra");
    const n = parseNotificationsConfig({}, createNotificationsDefaults);
    expect(n.downloads).not.toBe(parseNotificationsConfig({}, createNotificationsDefaults).downloads);
  });
});
