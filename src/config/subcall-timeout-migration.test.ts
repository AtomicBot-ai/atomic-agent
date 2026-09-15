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

const NEW_DEFAULTS = {
  reflection: 60_000,
  linkGenerator: 60_000,
  rewriter: 10_000,
};

function timeoutsOf(raw: Record<string, unknown>): typeof NEW_DEFAULTS {
  const parsed = parseUserConfigFile(raw);
  return {
    reflection: parsed.memory.reflection.timeoutMs,
    linkGenerator: parsed.memory.links.generatorTimeoutMs,
    rewriter: parsed.memory.retrieve.rewriter.timeoutMs,
  };
}

function fileWith(
  version: number,
  t: { reflection: number; linkGenerator: number; rewriter: number },
): Record<string, unknown> {
  return {
    version,
    memory: {
      reflection: { timeoutMs: t.reflection },
      links: { generatorTimeoutMs: t.linkGenerator },
      retrieve: { rewriter: { timeoutMs: t.rewriter } },
    },
  };
}

const OLD_DEFAULTS = {
  reflection: PRE_V65_SUBCALL_TIMEOUT_DEFAULTS.reflectionTimeoutMs,
  linkGenerator: PRE_V65_SUBCALL_TIMEOUT_DEFAULTS.linkGeneratorTimeoutMs,
  rewriter: PRE_V65_SUBCALL_TIMEOUT_DEFAULTS.rewriterTimeoutMs,
};

describe("memory sub-call timeouts (config v65)", () => {
  it("defaults reflection and link-generator to 60 s and the rewriter to 10 s", () => {
    // Hosted reasoning models answer these calls in 4–40 s; the old
    // local-llama-server defaults timed most of them out.
    expect(USER_CONFIG_DEFAULTS.memory.reflection.timeoutMs).toBe(60_000);
    expect(USER_CONFIG_DEFAULTS.memory.links.generatorTimeoutMs).toBe(60_000);
    expect(USER_CONFIG_DEFAULTS.memory.retrieve.rewriter.timeoutMs).toBe(
      10_000,
    );
    expect(timeoutsOf({ version: USER_CONFIG_VERSION })).toEqual(NEW_DEFAULTS);
  });

  it("reads a pre-v65 file's schema-written old defaults as the new defaults", () => {
    // Every existing config.json carries these fields, written by the
    // schema. Keeping them would leave every install on the timeouts
    // this version exists to replace.
    expect(OLD_DEFAULTS).toEqual({
      reflection: 10_000,
      linkGenerator: 8_000,
      rewriter: 3_000,
    });
    const raw = fileWith(PRE_V65, OLD_DEFAULTS);
    expect(timeoutsOf(raw)).toEqual(NEW_DEFAULTS);
    expect(parseUserConfigFile(raw).version).toBe(USER_CONFIG_VERSION);
  });

  it("migrates an older file the same way", () => {
    expect(timeoutsOf(fileWith(51, OLD_DEFAULTS))).toEqual(NEW_DEFAULTS);
  });

  it("keeps any other pre-v65 value as a deliberate pin", () => {
    const pinned = { reflection: 25_000, linkGenerator: 12_000, rewriter: 5_000 };
    expect(timeoutsOf(fileWith(PRE_V65, pinned))).toEqual(pinned);
    // The fields are independent: some pinned, some on the old default.
    expect(
      timeoutsOf(
        fileWith(PRE_V65, {
          reflection: 4_000,
          linkGenerator: 8_000,
          rewriter: 3_000,
        }),
      ),
    ).toEqual({ reflection: 4_000, linkGenerator: 60_000, rewriter: 10_000 });
    expect(
      timeoutsOf(
        fileWith(PRE_V65, {
          reflection: 10_000,
          linkGenerator: 8_000,
          rewriter: 1_500,
        }),
      ),
    ).toEqual({ reflection: 60_000, linkGenerator: 60_000, rewriter: 1_500 });
  });

  it("gives a pre-v65 file without the fields the new defaults", () => {
    expect(timeoutsOf({ version: PRE_V65, memory: {} })).toEqual(NEW_DEFAULTS);
  });

  it("keeps the old default numbers on a v65 file as the operator's pin", () => {
    expect(
      timeoutsOf(fileWith(HOSTED_SUBCALL_TIMEOUTS_VERSION, OLD_DEFAULTS)),
    ).toEqual(OLD_DEFAULTS);
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
        JSON.stringify(fileWith(PRE_V65, OLD_DEFAULTS)),
        "utf8",
      );
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        const migrated = ensureUserConfigFileSync(path);
        expect(migrated.memory.reflection.timeoutMs).toBe(60_000);
        expect(migrated.memory.links.generatorTimeoutMs).toBe(60_000);
        expect(migrated.memory.retrieve.rewriter.timeoutMs).toBe(10_000);
      } finally {
        stderr.mockRestore();
      }
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk.version).toBe(USER_CONFIG_VERSION);
      expect(onDisk.memory.reflection.timeoutMs).toBe(60_000);
      expect(onDisk.memory.links.generatorTimeoutMs).toBe(60_000);
      expect(onDisk.memory.retrieve.rewriter.timeoutMs).toBe(10_000);
    });
  });
});
