import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureUserConfigFileSync, getUserConfigPath } from "./config-file.js";
import {
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
  parseUserConfigFile,
} from "./config-schema.js";
import {
  HOSTED_SUBCALL_TIMEOUTS_VERSION,
  PRE_V65_SUBCALL_TIMEOUT_DEFAULTS,
} from "./subcall-timeout-migration.js";

const PRE_V65 = HOSTED_SUBCALL_TIMEOUTS_VERSION - 1;

function timeoutsOf(raw: Record<string, unknown>): {
  reflection: number;
  linkGenerator: number;
} {
  const parsed = parseUserConfigFile(raw);
  return {
    reflection: parsed.memory.reflection.timeoutMs,
    linkGenerator: parsed.memory.links.generatorTimeoutMs,
  };
}

describe("memory sub-call timeouts (config v65)", () => {
  it("defaults reflection and link-generator to 60 s", () => {
    // Hosted reasoning models answer these calls in 15–40 s; the old
    // local-llama-server defaults timed most of them out.
    expect(USER_CONFIG_DEFAULTS.memory.reflection.timeoutMs).toBe(60_000);
    expect(USER_CONFIG_DEFAULTS.memory.links.generatorTimeoutMs).toBe(60_000);
    expect(timeoutsOf({ version: USER_CONFIG_VERSION })).toEqual({
      reflection: 60_000,
      linkGenerator: 60_000,
    });
  });

  it("reads a pre-v65 file's schema-written old defaults as the new defaults", () => {
    // Every existing config.json carries these fields, written by the
    // schema. Keeping them would leave every install on the timeouts
    // this version exists to replace.
    const raw = {
      version: PRE_V65,
      memory: {
        reflection: {
          timeoutMs: PRE_V65_SUBCALL_TIMEOUT_DEFAULTS.reflectionTimeoutMs,
        },
        links: {
          generatorTimeoutMs:
            PRE_V65_SUBCALL_TIMEOUT_DEFAULTS.linkGeneratorTimeoutMs,
        },
      },
    };
    expect(timeoutsOf(raw)).toEqual({
      reflection: 60_000,
      linkGenerator: 60_000,
    });
    expect(parseUserConfigFile(raw).version).toBe(USER_CONFIG_VERSION);
  });

  it("migrates an older file the same way", () => {
    expect(
      timeoutsOf({
        version: 51,
        memory: {
          reflection: { timeoutMs: 10_000 },
          links: { generatorTimeoutMs: 8_000 },
        },
      }),
    ).toEqual({ reflection: 60_000, linkGenerator: 60_000 });
  });

  it("keeps any other pre-v65 value as a deliberate pin", () => {
    expect(
      timeoutsOf({
        version: PRE_V65,
        memory: {
          reflection: { timeoutMs: 25_000 },
          links: { generatorTimeoutMs: 12_000 },
        },
      }),
    ).toEqual({ reflection: 25_000, linkGenerator: 12_000 });
    // The fields are independent: one pinned, one on the old default.
    expect(
      timeoutsOf({
        version: PRE_V65,
        memory: {
          reflection: { timeoutMs: 4_000 },
          links: { generatorTimeoutMs: 8_000 },
        },
      }),
    ).toEqual({ reflection: 4_000, linkGenerator: 60_000 });
  });

  it("gives a pre-v65 file without the fields the new defaults", () => {
    expect(timeoutsOf({ version: PRE_V65, memory: {} })).toEqual({
      reflection: 60_000,
      linkGenerator: 60_000,
    });
  });

  it("keeps the old default numbers on a v65 file as the operator's pin", () => {
    expect(
      timeoutsOf({
        version: HOSTED_SUBCALL_TIMEOUTS_VERSION,
        memory: {
          reflection: { timeoutMs: 10_000 },
          links: { generatorTimeoutMs: 8_000 },
        },
      }),
    ).toEqual({ reflection: 10_000, linkGenerator: 8_000 });
  });

  describe("on disk", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "atomic-subcall-timeouts-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("rewrites a pre-v65 config.json with the migrated timeouts", () => {
      const path = getUserConfigPath(dir);
      writeFileSync(
        path,
        JSON.stringify({
          version: PRE_V65,
          memory: {
            reflection: { timeoutMs: 10_000 },
            links: { generatorTimeoutMs: 8_000 },
          },
        }),
        "utf8",
      );
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        const migrated = ensureUserConfigFileSync(path);
        expect(migrated.memory.reflection.timeoutMs).toBe(60_000);
        expect(migrated.memory.links.generatorTimeoutMs).toBe(60_000);
      } finally {
        stderr.mockRestore();
      }
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk.version).toBe(USER_CONFIG_VERSION);
      expect(onDisk.memory.reflection.timeoutMs).toBe(60_000);
      expect(onDisk.memory.links.generatorTimeoutMs).toBe(60_000);
    });
  });
});
