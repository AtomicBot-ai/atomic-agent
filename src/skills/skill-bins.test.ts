import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseSkillBins } from "./skill-bins.js";
import { parseSkillFile } from "./skill-manifest.js";
import { skillBinsRow } from "../http/route-skills.js";
import { resolveStarterSkillsSourceDir } from "./seed-starter-skills.js";

const file = (...fm: string[]) => ["---", "name: demo-skill", 'description: "Demo"', ...fm, "---", "body"].join("\n");

describe("ATO-526: requires_bins and install hints", () => {
  it("reads requires_bins and a per-platform install map", () => {
    const { manifest } = parseSkillFile(file(
      "requires_bins: [gh, \"magick|convert\"]",
      "install:",
      "  darwin: brew install gh",
      "  linux: apt-get install gh",
    ));
    expect(manifest.requiresBins).toEqual(["gh", "magick|convert"]);
    expect(manifest.installHints).toEqual({ darwin: "brew install gh", linux: "apt-get install gh" });
  });

  it("a single install string applies to every platform", () => {
    expect(parseSkillBins({ requires_bins: ["uvx"], install: "Install uv: https://docs.astral.sh/uv/" }))
      .toEqual({ requiresBins: ["uvx"], installHints: { any: "Install uv: https://docs.astral.sh/uv/" } });
  });

  it("leaves both keys off a manifest that declares nothing (old snapshots stay equal)", () => {
    const { manifest } = parseSkillFile(file("version: 1.0.0"));
    expect("requiresBins" in manifest).toBe(false);
    expect("installHints" in manifest).toBe(false);
  });

  it("drops names that are not bare program names, never failing the manifest", () => {
    expect(parseSkillBins({ requires_bins: ["/usr/bin/gh", "rm -rf", "", 7, "gh", "gh", "a|b|c|d|e", "ok-1.2+x"] }))
      .toEqual({ requiresBins: ["gh", "ok-1.2+x"] });
    expect(parseSkillBins({ requires_bins: "gh" })).toEqual({});
  });

  it("an install hint without any required program is not kept", () => {
    expect(parseSkillBins({ install: "brew install gh" })).toEqual({});
  });

  it("drops an over-long hint and unknown platform keys", () => {
    expect(parseSkillBins({ requires_bins: ["gh"], install: { darwin: "x".repeat(201), plan9: "y", win32: "winget install GitHub.cli" } }))
      .toEqual({ requiresBins: ["gh"], installHints: { win32: "winget install GitHub.cli" } });
  });

  it("reads an OpenClaw / ClawHub metadata block when the top-level keys are absent", () => {
    const { manifest } = parseSkillFile(file(
      'metadata: {"openclaw": {"requires": {"bins": ["gh"]}, "install": [{"id": "brew", "kind": "brew", "formula": "gh"}, {"kind": "node", "package": "@acme/cli"}]}}',
    ));
    expect(manifest.requiresBins).toEqual(["gh"]);
    expect(manifest.installHints).toEqual({ darwin: "brew install gh", any: "npm install -g @acme/cli" });
    // The nested block is not a string map, so the spec `metadata` field stays as before.
    expect(manifest.metadata).toBeUndefined();
  });

  it("the top-level keys win over the OpenClaw block", () => {
    expect(parseSkillBins({ requires_bins: ["a"], install: "own", metadata: { openclaw: { requires: { bins: ["b"] }, install: [{ kind: "brew", formula: "b" }] } } }))
      .toEqual({ requiresBins: ["a"], installHints: { any: "own" } });
  });

  it("the skills list row carries the fields only when declared", () => {
    const { manifest } = parseSkillFile(file("requires_bins: [gh]", "install: {darwin: brew install gh}"));
    expect(skillBinsRow(manifest)).toEqual({ requiresBins: ["gh"], installHints: { darwin: "brew install gh" } });
    expect(skillBinsRow(parseSkillFile(file()).manifest)).toEqual({});
  });

  it("every starter skill that names a CLI declares it, with a macOS hint taken from its own playbook", () => {
    const root = resolveStarterSkillsSourceDir();
    if (root === null) throw new Error("starter-skills tree not found");
    const declared: Record<string, string[]> = {};
    for (const name of readdirSync(root)) {
      const path = join(root, name, "SKILL.md");
      if (!existsSync(path)) continue;
      const { manifest } = parseSkillFile(readFileSync(path, "utf8"));
      if (!manifest.requiresBins) continue;
      declared[name] = manifest.requiresBins;
      expect(manifest.installHints?.darwin ?? manifest.installHints?.any, name).toBeTruthy();
    }
    expect(declared).toMatchObject({
      "apple-calendar": ["icalBuddy"], "apple-notes": ["memo"], "apple-reminders": ["remindctl"],
      docker: ["docker"], github: ["gh"], ffmpeg: ["ffmpeg", "ffprobe"], "gog-workspace": ["gog"],
      imagemagick: ["magick|convert"], pandoc: ["pandoc"], pdf: ["pdfinfo", "qpdf"], "audio-transcribe": ["whisper", "ffmpeg"],
    });
  });
});
