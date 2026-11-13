import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  parseUserConfigFile,
  USER_CONFIG_DEFAULTS,
} from "./config-schema.js";
import { configBranchKind } from "./config-shape.js";
import {
  FILE_TRIGGER_DEFAULTS,
  parseFileTriggerMap,
  type FileTriggerConfig,
} from "./file-trigger-config.js";

function parsedTrigger(raw: Record<string, unknown>): FileTriggerConfig {
  const trigger = parseFileTriggerMap({ inbox: raw }, "fileTriggers").inbox;
  if (trigger === undefined) throw new Error("parsed trigger fixture is missing");
  return trigger;
}

const BASE = { path: "~/Inbox", userMessageTemplate: "Process {{path}}" };

describe("parseFileTriggerMap", () => {
  it("fills the defaults for a minimal entry", () => {
    expect(parsedTrigger(BASE)).toStrictEqual({
      path: "~/Inbox",
      events: ["add"],
      debounceMs: FILE_TRIGGER_DEFAULTS.debounceMs,
      userMessageTemplate: "Process {{path}}",
      depth: FILE_TRIGGER_DEFAULTS.depth,
      maxFiles: FILE_TRIGGER_DEFAULTS.maxFiles,
      enabled: true,
    });
  });

  it("keeps every optional field", () => {
    expect(
      parsedTrigger({
        ...BASE,
        path: "/var/log/app.log",
        glob: "*.log",
        events: ["change", "add", "change"],
        contains: "ERROR",
        debounceMs: 0,
        sessionId: "s-1",
        depth: 0,
        maxFiles: 5,
        enabled: false,
      }),
    ).toStrictEqual({
      path: "/var/log/app.log",
      glob: "*.log",
      events: ["change", "add"],
      contains: "ERROR",
      debounceMs: 0,
      userMessageTemplate: "Process {{path}}",
      sessionId: "s-1",
      depth: 0,
      maxFiles: 5,
      enabled: false,
    });
  });

  it("reads an absent or null block as empty", () => {
    expect(parseFileTriggerMap(undefined, "fileTriggers")).toStrictEqual({});
    expect(parseFileTriggerMap(null, "fileTriggers")).toStrictEqual({});
  });

  it.each([
    [{ ...BASE, path: "Inbox" }, "fileTriggers.inbox.path"],
    [{ ...BASE, path: "" }, "fileTriggers.inbox.path"],
    [{ path: "/tmp/x" }, "fileTriggers.inbox.userMessageTemplate"],
    [{ ...BASE, events: [] }, "fileTriggers.inbox.events"],
    [{ ...BASE, events: ["unlink"] }, "fileTriggers.inbox.events"],
    [{ ...BASE, debounceMs: -1 }, "fileTriggers.inbox.debounceMs"],
    [{ ...BASE, debounceMs: 600_001 }, "fileTriggers.inbox.debounceMs"],
    [{ ...BASE, depth: 9 }, "fileTriggers.inbox.depth"],
    [{ ...BASE, maxFiles: 0 }, "fileTriggers.inbox.maxFiles"],
    [{ ...BASE, maxFiles: 10_001 }, "fileTriggers.inbox.maxFiles"],
    [{ ...BASE, contains: "x".repeat(1_001) }, "fileTriggers.inbox.contains"],
    [{ ...BASE, glob: "" }, "fileTriggers.inbox.glob"],
  ])("rejects %j at %s", (raw, field) => {
    let error: unknown;
    try {
      parseFileTriggerMap({ inbox: raw }, "fileTriggers");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).field).toBe(field);
  });

  it("rejects bad names and non-object entries", () => {
    expect(() => parseFileTriggerMap({ "bad name": BASE }, "fileTriggers")).toThrow(ConfigValidationError);
    expect(() => parseFileTriggerMap({ inbox: "x" }, "fileTriggers")).toThrow(ConfigValidationError);
    expect(() => parseFileTriggerMap([], "fileTriggers")).toThrow(ConfigValidationError);
  });
});

describe("fileTriggers in the whole config file", () => {
  it("defaults to an empty dictionary and parses entries", () => {
    expect(USER_CONFIG_DEFAULTS.fileTriggers).toStrictEqual({});
    expect(configBranchKind("fileTriggers")).toBe("dictionary");
    const parsed = parseUserConfigFile({ ...USER_CONFIG_DEFAULTS, fileTriggers: { inbox: BASE } });
    expect(parsed.fileTriggers).toStrictEqual(parseFileTriggerMap({ inbox: BASE }, "fileTriggers"));
  });

  it("reads a file written before the block existed", () => {
    const older: Record<string, unknown> = { ...USER_CONFIG_DEFAULTS };
    delete older.fileTriggers;
    expect(parseUserConfigFile(older).fileTriggers).toStrictEqual({});
  });
});
