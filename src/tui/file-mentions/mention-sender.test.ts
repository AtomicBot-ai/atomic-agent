import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateSecretPaths } from "../../config/index.js";
import type { MentionServices } from "../../mentions/index.js";
import { createMentionSender } from "./mention-sender.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mention-sender-")));
  writeFileSync(join(dir, "a.ts"), "a\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createMentionSender (ATO-2472)", () => {
  it("answers at once for plain files and waits for the shared expansion otherwise", async () => {
    const services: MentionServices = {
      expandNow: (text) => (text.includes("@diff") ? null : `${text} [files]`),
      expand: vi.fn(async (text: string) => `${text} [all]`),
      problems: async () => ({ state: "off" }),
    };
    const sender = createMentionSender(services, () => dir, []);
    expect(sender.expand("see @a.ts")).toBe("see @a.ts [files]");
    await expect(sender.expand("see @diff")).resolves.toBe("see @diff [all]");
    expect(services.expand).toHaveBeenCalledWith("see @diff", dir);
  });

  it("falls back to the plain files when the expansion fails", async () => {
    const services: MentionServices = {
      expandNow: () => null,
      expand: async () => { throw new Error("broken"); },
      problems: async () => ({ state: "off" }),
    };
    const out = await createMentionSender(services, () => dir, []).expand("see @a.ts @diff");
    expect(out).toContain('<file path="a.ts">');
  });

  it("works without runtime services, files only", () => {
    expect(createMentionSender(undefined, () => dir, []).expand("see @a.ts")).toContain('<file path="a.ts">');
  });

  describe("in the agent's own state folder (ATO-2796)", () => {
    const SECRET = "OPENAI_API_KEY=sk-test-do-not-leak";
    let secrets: readonly string[];
    beforeEach(() => {
      // The chat's folder is a fake state folder: core's list for it.
      writeFileSync(join(dir, ".env"), `${SECRET}\n`);
      writeFileSync(join(dir, "config.json"), '{"note":"config-secret-marker"}');
      mkdirSync(join(dir, "models"));
      secrets = getStateSecretPaths({ userConfigFile: join(dir, "config.json"), stateDir: dir, localModelsDataDir: join(dir, "models") });
    });

    it("never inlines @.env or @config.json without runtime services", () => {
      const out = createMentionSender(undefined, () => dir, secrets).expand("see @.env @config.json @a.ts") as string;
      expect(out).not.toContain("sk-test-do-not-leak");
      expect(out).not.toContain("config-secret-marker");
      expect(out).toContain("not inlined: the agent's own settings file is never inlined");
      expect(out).toContain('<file path="a.ts">');
    });

    it("never inlines @.env when the shared expansion fails", async () => {
      const services: MentionServices = {
        expandNow: () => null,
        expand: async () => { throw new Error("broken"); },
        problems: async () => ({ state: "off" }),
      };
      const out = await createMentionSender(services, () => dir, secrets).expand("see @.env @diff");
      expect(out).not.toContain("sk-test-do-not-leak");
    });
  });
});
