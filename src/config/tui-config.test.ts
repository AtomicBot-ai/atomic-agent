import { describe, expect, it } from "vitest";
import {
  createTuiDefaults,
  parseOnboardingStateWithDefaults,
  parseThemeName,
  parseTimestampOrNull,
  parseTuiConfig,
  parseTuiNotifyWithDefaults,
  parseWhileBusySubmit,
} from "./tui-config.js";
import {
  ConfigValidationError,
  parseOnboardingState,
  parseThemeName as rootThemeName,
  parseTimestampOrNull as rootTimestampOrNull,
  parseTuiNotify,
  parseUserConfigFile,
  parseWhileBusySubmit as rootWhileBusySubmit,
  USER_CONFIG_DEFAULTS,
} from "./config-schema.js";
import { ConfigValidationError as OwnedValidationError } from "./config-validation-error.js";

function thrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected parsing to fail");
}

describe("TUI configuration ownership", () => {
  it("preserves pure function/error identity and permissive theme/timestamp semantics", () => {
    expect(rootThemeName).toBe(parseThemeName);
    expect(rootTimestampOrNull).toBe(parseTimestampOrNull);
    expect(rootWhileBusySubmit).toBe(parseWhileBusySubmit);
    expect(ConfigValidationError).toBe(OwnedValidationError);
    expect(parseThemeName("  custom unknown  ", "tui.theme")).toBe("custom unknown");
    expect(parseThemeName("  ", "tui.theme")).toBe("auto");
    expect(parseTimestampOrNull("March 1, 2020", "stamp")).toBe("March 1, 2020");
    expect(parseTimestampOrNull(null, "stamp")).toBeNull();
    expect(thrownError(() => parseWhileBusySubmit("QUEUE", "busy"))).toEqual(
      new ConfigValidationError("busy", 'expected "steer" or "queue", got "QUEUE"'),
    );
  });

  it("constructs the previous ordered defaults with independent nested objects and arrays", () => {
    const first = createTuiDefaults();
    const second = createTuiDefaults();
    expect(first).toEqual(USER_CONFIG_DEFAULTS.tui);
    expect(Object.keys(first)).toEqual([
      "theme", "whileBusySubmit", "mouse", "notify", "sessionRail", "onboarding",
    ]);
    expect(Object.keys(first.onboarding)).toEqual([
      "completedAt", "importOfferedAt", "introSeenAt", "localSetupSeenAt",
      "proposedSecondBackendAt", "skippedAt",
    ]);
    expect(first.notify).not.toBe(second.notify);
    expect(first.onboarding).not.toBe(second.onboarding);
    expect(first.sessionRail).not.toBe(second.sessionRail);
    first.sessionRail.order.push("first");
    first.sessionRail.pinned.push("first");
    expect(second.sessionRail).toEqual({ order: [], pinned: [] });
  });

  it("keeps compatibility wrappers current and absent spreads distinct from present normalization", () => {
    const saved = USER_CONFIG_DEFAULTS.tui;
    try {
      const onboarding = Object.assign({}, saved.onboarding, {
        completedAt: "an unvalidated default stamp", extra: "retained on absence",
      });
      const notify = Object.assign({}, saved.notify, {
        enabled: false, minDurationMs: -5, extra: "retained on absence",
      });
      USER_CONFIG_DEFAULTS.tui = { ...saved, onboarding, notify };
      const absentOnboarding = parseOnboardingState(undefined);
      expect(absentOnboarding).toEqual(onboarding);
      expect(absentOnboarding).not.toBe(onboarding);
      expect(parseOnboardingState({})).toEqual(createTuiDefaults().onboarding);
      expect(parseTuiNotify(null)).toEqual(notify);
      expect(thrownError(() => parseTuiNotify({}))).toEqual(
        new ConfigValidationError("tui.notify.minDurationMs", "expected non-negative integer, got -5"),
      );
      USER_CONFIG_DEFAULTS.tui = {
        ...saved, notify: { enabled: false, minDurationMs: 0 },
      };
      expect(parseTuiNotify({})).toEqual({ enabled: false, minDurationMs: 0 });
      expect(parseOnboardingState(undefined)).toEqual(saved.onboarding);
    } finally {
      USER_CONFIG_DEFAULTS.tui = saved;
    }
  });

  it("reads a helper default once on entry even before rejecting a nonobject", () => {
    const defaults = createTuiDefaults();
    const events: string[] = [];
    const onboardingError = thrownError(() => parseOnboardingStateWithDefaults([], () => {
      events.push("onboarding-default");
      return defaults.onboarding;
    }));
    const notifyError = thrownError(() => parseTuiNotifyWithDefaults(false, () => {
      events.push("notify-default");
      return defaults.notify;
    }));
    expect(events).toEqual(["onboarding-default", "notify-default"]);
    expect(onboardingError).toBeInstanceOf(ConfigValidationError);
    expect(notifyError).toBeInstanceOf(ConfigValidationError);
  });

  it("retains the notify object captured before a raw getter replaces defaults", () => {
    const initial = { enabled: true, minDurationMs: 30_000 };
    let current = initial;
    let reads = 0;
    const raw = {
      get enabled() {
        current = { enabled: true, minDurationMs: 1 };
        return false;
      },
    };
    expect(parseTuiNotifyWithDefaults(raw, () => {
      reads++;
      return current;
    })).toEqual({ enabled: false, minDurationMs: 30_000 });
    expect(reads).toBe(1);
    expect(current).not.toBe(initial);
  });

  it("retains onboarding object permissiveness and ignores defaults on present fields", () => {
    const defaults = {
      ...createTuiDefaults().onboarding, completedAt: "invalid default stamp",
    };
    let reads = 0;
    const parsed = parseOnboardingStateWithDefaults(new Date(0), () => {
      reads++;
      return defaults;
    });
    expect(parsed).toEqual(createTuiDefaults().onboarding);
    expect(reads).toBe(1);
    expect(Object.keys(parsed)).toEqual([
      "completedAt", "introSeenAt", "skippedAt", "proposedSecondBackendAt",
      "localSetupSeenAt", "importOfferedAt",
    ]);
  });

  it("preserves late getter order, outer refreshed defaults and raw-before-helper lookup", () => {
    let current = { ...createTuiDefaults(), theme: "initial-theme" };
    let phase = "initial";
    const events: string[] = [];
    const raw = {
      get theme() { events.push("raw-theme"); return undefined; },
      get whileBusySubmit() {
        events.push("raw-busy");
        current = { ...current, whileBusySubmit: "queue" };
        phase = "busy";
        return undefined;
      },
      get mouse() { events.push("raw-mouse"); return false; },
      get onboarding() {
        events.push("raw-onboarding");
        current = { ...current, onboarding: { ...current.onboarding, skippedAt: "default stamp" } };
        phase = "onboarding";
        return undefined;
      },
      get sessionRail() {
        events.push("raw-rail");
        return { order: ["a", "a"], pinned: [] };
      },
      get notify() {
        events.push("raw-notify");
        current = { ...current, notify: { enabled: false, minDurationMs: 0 } };
        phase = "notify";
        return undefined;
      },
    };
    const parsed = parseTuiConfig(raw, () => {
      events.push(`defaults-${phase}`);
      return current;
    });
    expect(events).toEqual([
      "raw-theme", "defaults-initial", "raw-busy", "defaults-busy", "raw-mouse",
      "raw-onboarding", "defaults-onboarding", "raw-rail", "raw-notify", "defaults-notify",
    ]);
    expect(parsed.theme).toBe("initial-theme");
    expect(parsed.whileBusySubmit).toBe("queue");
    expect(parsed.mouse).toBe(false);
    expect(parsed.onboarding.skippedAt).toBe("default stamp");
    expect(parsed.sessionRail.order).toEqual(["a"]);
    expect(parsed.notify).toEqual({ enabled: false, minDurationMs: 0 });
    expect(Object.keys(parsed)).toEqual([
      "theme", "whileBusySubmit", "mouse", "onboarding", "sessionRail", "notify",
    ]);
  });

  it("preserves field failure order and validates notify fields even when disabled", () => {
    const defaults = createTuiDefaults();
    const error = thrownError(() => parseTuiConfig({
      whileBusySubmit: "invalid", onboarding: [], notify: { minDurationMs: -1 },
    }, () => defaults));
    expect(error).toEqual(new ConfigValidationError(
      "tui.whileBusySubmit", 'expected "steer" or "queue", got "invalid"',
    ));
    expect(thrownError(() => parseTuiNotifyWithDefaults({
      enabled: false, minDurationMs: -1,
    }, () => defaults.notify))).toBeInstanceOf(ConfigValidationError);
  });

  it("keeps root composition permissive and parsed nested objects fresh", () => {
    const defaults = createTuiDefaults();
    const first = parseTuiConfig({}, () => defaults);
    const second = parseTuiConfig({}, () => defaults);
    expect(parseUserConfigFile({ tui: "primitive" }).tui).toEqual(first);
    expect(parseUserConfigFile({ tui: {} }).tui).toEqual(first);
    expect(first).not.toBe(second);
    expect(first.onboarding).not.toBe(second.onboarding);
    expect(first.notify).not.toBe(second.notify);
    expect(first.sessionRail.order).not.toBe(second.sessionRail.order);
    expect(first.sessionRail.pinned).not.toBe(second.sessionRail.pinned);
  });
});
