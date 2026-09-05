import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";

describe("/max_steps dispatch", () => {
  let previousStateDir: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    previousStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
    stateDir = mkdtempSync(join(tmpdir(), "atomic-max-steps-dispatch-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    if (previousStateDir === undefined) {
      delete process.env.ATOMIC_AGENT_STATE_DIR;
    } else {
      process.env.ATOMIC_AGENT_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("requests the active value without reading or writing config", () => {
    const result = dispatchSlashCommand("/max_steps");

    expect(result.maxStepsRequest).toEqual({ kind: "status" });
    expect(existsSync(join(stateDir, "config.json"))).toBe(false);
  });

  it("parses a new value without applying or persisting it", () => {
    const result = dispatchSlashCommand("/max_steps 41");

    expect(result.maxStepsRequest).toEqual({ kind: "set", value: 41 });
    expect(existsSync(join(stateDir, "config.json"))).toBe(false);
  });

  it.each(["0", "-1", "1.5", "nope"])(
    "rejects invalid value %s without requesting a change",
    (value) => {
      const result = dispatchSlashCommand(`/max_steps ${value}`);

      expect(result.maxStepsRequest).toBeUndefined();
      expect(result.systemMessage).toContain("positive integer");
      expect(existsSync(join(stateDir, "config.json"))).toBe(false);
    },
  );
});
