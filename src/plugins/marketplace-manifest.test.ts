import { describe, expect, it } from "vitest";
import { checkGitUrl, MarketplaceError, parseEntrySource, parseMarketplaceObject, safeRelative } from "./marketplace-manifest.js";

describe("marketplace manifest", () => {
  it("reads the Claude format with every source kind", () => {
    const m = parseMarketplaceObject({
      name: "claude-plugins-official",
      owner: { name: "Anthropic" },
      metadata: { description: "Directory" },
      plugins: [
        { name: "local-one", description: "In repo", source: "./plugins/local-one", version: "1.0.0" },
        { name: "gh", source: { source: "github", repo: "acme/gh-plugin", ref: "v2" } },
        { name: "sub", source: { source: "git-subdir", url: "https://github.com/acme/mono.git", path: "plugins/sub", ref: "main", sha: "0f487c9b1b98d8e62dfc80ee4d28b29f5471261f" } },
        { name: "url", source: { source: "url", url: "https://github.com/acme/url.git" } },
        { name: "npm", source: { source: "npm", package: "x" } },
        { name: "cmd", source: { source: "command", command: "xcrun agent plugin path" } },
        { name: "skills-only", source: "./skills", strict: false, skills: ["./a", "./b"] },
      ],
    });
    expect(m).toMatchObject({ name: "claude-plugins-official", owner: "Anthropic", description: "Directory", problems: [] });
    const byName = Object.fromEntries(m.plugins.map(p => [p.name, p]));
    expect(byName["local-one"]!.source).toEqual({ kind: "relative", path: "plugins/local-one" });
    expect(byName.gh!.source).toEqual({ kind: "github", repo: "acme/gh-plugin", ref: "v2" });
    expect(byName.sub!.source).toMatchObject({ kind: "git", url: "https://github.com/acme/mono.git", path: "plugins/sub", sha: "0f487c9b1b98d8e62dfc80ee4d28b29f5471261f" });
    expect(byName.url!.source).toEqual({ kind: "git", url: "https://github.com/acme/url.git" });
    expect(byName.npm!.source.kind).toBe("unsupported");
    expect(byName.cmd!.source).toMatchObject({ kind: "unsupported", type: "command" });
    expect(byName["skills-only"]).toMatchObject({ strict: false, components: { skills: ["./a", "./b"] } });
  });

  it("applies metadata.pluginRoot to bare relative sources only", () => {
    expect(parseEntrySource("formatter", "./plugins")).toEqual({ kind: "relative", path: "plugins/formatter" });
    expect(parseEntrySource("./x", "./plugins")).toEqual({ kind: "relative", path: "x" });
    expect(parseEntrySource("./")).toEqual({ kind: "relative", path: "" });
  });

  it("keeps a bad entry as a problem instead of failing the marketplace", () => {
    const m = parseMarketplaceObject({ name: "m", plugins: [{ name: "ok", source: "./ok" }, { source: "./x" }, { name: "escape", source: "../../etc" }, { name: "ok", source: "./dup" }] });
    expect(m.plugins.map(p => p.name)).toEqual(["ok"]);
    expect(m.problems).toHaveLength(3);
  });

  it("refuses a missing or unsafe marketplace name", () => {
    expect(() => parseMarketplaceObject({ plugins: [] })).toThrow(MarketplaceError);
    expect(() => parseMarketplaceObject({ name: "../x", plugins: [] })).toThrow(MarketplaceError);
    expect(() => parseMarketplaceObject({ name: "m" })).toThrow(/plugins/);
  });

  it("allows only https and ssh git URLs", () => {
    expect(checkGitUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(checkGitUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
    expect(checkGitUrl("ssh://git@host/a/b")).toBe("ssh://git@host/a/b");
    for (const bad of ["http://x/a.git", "file:///etc", "ext::sh -c id", "--upload-pack=touch /tmp/x", "/local/repo"]) {
      expect(() => checkGitUrl(bad)).toThrow(MarketplaceError);
    }
  });

  it("keeps relative paths inside", () => {
    expect(safeRelative("./a/b/")).toBe("a/b");
    expect(safeRelative("a/../b")).toBe("b");
    expect(() => safeRelative("../a")).toThrow();
    expect(() => safeRelative("/etc")).toThrow();
    expect(() => safeRelative("C:\\x")).toThrow();
  });
});
