import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `motion` starter (ATO-1165): three HTML video templates (release,
 * big number, logo reveal) and a fallback renderer. These cases pin the
 * frame contract the HTML-to-MP4 path depends on, keep the templates
 * deterministic and light, and check the renderer's pure helpers.
 */
describe("the motion starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const root = join(dir, "motion");
  const body = readFileSync(join(root, "SKILL.md"), "utf8");
  const scriptPath = join(root, "scripts", "render-frames.mjs");
  const templates = {
    release: 6,
    "big-number": 5,
    "logo-reveal": 4,
  } as const;
  const html = (name: string) =>
    readFileSync(join(root, "templates", `${name}.html`), "utf8");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("motion");
    const { manifest } = parseSkillFile(body);
    expect(manifest.name).toBe("motion");
    expect(manifest.requiresScripts).toEqual(["render-frames.mjs"]);
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("documents the frame contract and both render paths", () => {
    expect(body).toMatch(/## Frame contract/);
    expect(body).toMatch(/`window\.__setTime\(t\)`/);
    expect(body).toMatch(/`\?t=<seconds>`/);
    expect(body).toMatch(/`window\.__ready === true`/);
    expect(body).toMatch(/\*\*If this agent has an HTML-to-MP4 tool\*\*/);
    expect(body).toMatch(/\*\*Otherwise use the bundled script\*\*/);
    expect(body).toMatch(/ffmpeg -framerate 30 -i frame_%05d\.png/);
  });

  it("keeps scenes light and numbers real", () => {
    expect(body).toMatch(/no black or\s+near-black backgrounds/);
    expect(body).toMatch(/Never make up a number for the video/);
    expect(body).not.toMatch(/[—–]/);
  });

  for (const [name, seconds] of Object.entries(templates)) {
    describe(`template ${name}`, () => {
      const page = html(name);

      it("follows the frame contract", () => {
        expect(page).toContain(`<meta name="motion:duration" content="${seconds}">`);
        expect(page).toContain(`var DURATION = ${seconds};`);
        expect(page).toContain("window.__setTime");
        expect(page).toContain("window.__ready = true");
        expect(page).toContain('q.has("t")');
      });

      it("is deterministic and self-contained", () => {
        expect(page).not.toMatch(/Math\.random|Date\.now|new Date\(/);
        expect(page).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|fonts\.googleapis/);
      });

      it("defaults to a light background", () => {
        const match = page.match(/P\("bg", "([0-9a-f,]+)"\)/);
        expect(match).not.toBeNull();
        for (const colour of match![1].split(",")) {
          const [r, g, b] = [0, 2, 4].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255);
          expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(0.8);
        }
      });
    });
  }

  it("parses render options", async () => {
    const mod = await import(pathToFileURL(scriptPath).href);
    const opts = mod.parseArgs(["release", "out.mp4", "--fps", "24", "--w", "1080", "--h", "1920", "--params", "version=v1"]);
    expect(opts).toMatchObject({ template: "release", out: "out.mp4", fps: 24, w: 1080, h: 1920, params: "version=v1" });
    expect(() => mod.parseArgs(["release"])).toThrow(/usage/);
    expect(() => mod.parseArgs(["release", "o.mp4", "--fps", "0"])).toThrow(/positive/);
  });

  it("resolves bundled template names and reads their duration", async () => {
    const mod = await import(pathToFileURL(scriptPath).href);
    for (const [name, seconds] of Object.entries(templates)) {
      const path = mod.resolveTemplate(name);
      expect(existsSync(path)).toBe(true);
      expect(mod.readDuration(readFileSync(path, "utf8"))).toBe(seconds);
    }
    expect(mod.readDuration("<html></html>")).toBeNull();
  });

  it("captures exactly duration x fps frames from t=0", async () => {
    const mod = await import(pathToFileURL(scriptPath).href);
    const times = mod.frameTimes(2, 30);
    expect(times).toHaveLength(60);
    expect(times[0]).toBe(0);
    expect(times[59]).toBeCloseTo(59 / 30, 4);
  });

  it("builds the frame URL and the ffmpeg command", async () => {
    const mod = await import(pathToFileURL(scriptPath).href);
    const url = new URL(mod.frameUrl("/tmp/x/release.html", "version=v0.7.0&headline=Hi%20there", 1.5, 1080, 1920));
    expect(url.protocol).toBe("file:");
    expect(url.searchParams.get("version")).toBe("v0.7.0");
    expect(url.searchParams.get("headline")).toBe("Hi there");
    expect(url.searchParams.get("t")).toBe("1.5");
    expect(url.searchParams.get("w")).toBe("1080");
    expect(url.searchParams.get("h")).toBe("1920");
    expect(new URL(mod.frameUrl("/tmp/x/release.html", "", undefined, 10, 10)).searchParams.has("t")).toBe(false);

    const args: string[] = mod.ffmpegArgs("/frames", 30, "/out/v.mp4");
    expect(args).toEqual(expect.arrayContaining(["-framerate", "30", "libx264", "yuv420p"]));
    expect(args[args.indexOf("-i") + 1]).toBe(join("/frames", "frame_%05d.png"));
    expect(args.at(-1)).toBe("/out/v.mp4");
  });
});
