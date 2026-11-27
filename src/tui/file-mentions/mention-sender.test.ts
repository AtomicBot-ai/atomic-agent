import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const sender = createMentionSender(services, () => dir);
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
    const out = await createMentionSender(services, () => dir).expand("see @a.ts @diff");
    expect(out).toContain('<file path="a.ts">');
  });

  it("works without runtime services, files only", () => {
    expect(createMentionSender(undefined, () => dir).expand("see @a.ts")).toContain('<file path="a.ts">');
  });
});
