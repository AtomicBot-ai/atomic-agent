import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginFetcher } from "./marketplace-fetch.js";
import { MarketplaceError } from "./marketplace-manifest.js";
import { readMarketplaceLock } from "./marketplace-store.js";
import {
  addMarketplace,
  installMarketplacePlugin,
  listMarketplaces,
  looksLikePluginSpec,
  parseMarketplaceInput,
  removeMarketplace,
  resolveMarketplacePlugin,
  updateMarketplaces,
  updatePlugin,
} from "./marketplace.js";
import { readPluginBundle } from "./plugin-bundle.js";
import { PluginInstallError } from "./plugin-install.js";
import { installedPluginDir, readPluginState } from "./plugin-store.js";
import { writeClaudePlugin } from "./plugin-test-helpers.js";

/** Fake network: each URL is a local folder; `shas` says which commit it is "at". */
function fakeFetcher(repos: Record<string, string>, shas: Record<string, string> = {}, texts: Record<string, string> = {}) {
  const calls: Array<{ url: string; ref?: string; sha?: string }> = [];
  const fetcher: PluginFetcher = {
    async gitCheckout(url, dest, opts = {}) {
      calls.push({ url, ...opts });
      const src = repos[url];
      if (!src) throw new MarketplaceError(`fake: no repo ${url}`);
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
      return { sha: opts.sha ?? shas[url] ?? "a".repeat(40) };
    },
    async fetchText(url) {
      const t = texts[url];
      if (t === undefined) throw new MarketplaceError(`fake: no file ${url}`);
      return t;
    },
  };
  return { fetcher, calls };
}

function writeMarketplace(root: string, plugins: unknown[], name = "acme"): string {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name, owner: { name: "Acme" }, plugins }));
  return root;
}

describe("plugin marketplaces", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-marketplace-"));
    stateDir = join(base, "state");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("parses the forms `marketplace add` accepts", () => {
    const mk = join(base, "mk");
    writeMarketplace(mk, []);
    expect(parseMarketplaceInput("anthropics/claude-plugins-official", base)).toEqual({ kind: "github", repo: "anthropics/claude-plugins-official" });
    expect(parseMarketplaceInput("https://github.com/a/b.git", base)).toEqual({ kind: "git", url: "https://github.com/a/b.git" });
    expect(parseMarketplaceInput("git@github.com:a/b.git", base)).toEqual({ kind: "git", url: "git@github.com:a/b.git" });
    expect(parseMarketplaceInput("https://example.com/m/marketplace.json", base)).toEqual({ kind: "url", url: "https://example.com/m/marketplace.json" });
    expect(parseMarketplaceInput("./mk", base)).toEqual({ kind: "local", path: mk });
    expect(() => parseMarketplaceInput("http://example.com/a.git", base)).toThrow(/https/);
  });

  it("adds a git marketplace, pins its commit and installs a relative plugin from it", async () => {
    const repo = writeMarketplace(join(base, "repo"), [{ name: "demo", source: "./plugins/demo", version: "1.2.0" }]);
    writeClaudePlugin(join(repo, "plugins", "demo"));
    const { fetcher, calls } = fakeFetcher({ "https://github.com/acme/market.git": repo }, { "https://github.com/acme/market.git": "b".repeat(40) });

    const { record, manifest } = await addMarketplace(stateDir, "acme/market", { fetcher, ref: "stable", cwd: base });
    expect(record).toMatchObject({ name: "acme", source: { kind: "github", repo: "acme/market" }, ref: "stable", sha: "b".repeat(40), manifestPath: ".claude-plugin/marketplace.json" });
    expect(manifest.plugins.map(p => p.name)).toEqual(["demo"]);
    expect(calls[0]).toEqual({ url: "https://github.com/acme/market.git", ref: "stable" });
    expect(readMarketplaceLock(stateDir).marketplaces.acme?.sha).toBe("b".repeat(40));

    const res = await installMarketplacePlugin(stateDir, "demo@acme", { fetcher });
    expect(res.record).toMatchObject({
      name: "demo",
      enabled: true,
      source: { kind: "marketplace", marketplace: "acme", entry: "demo", url: "https://github.com/acme/market.git", ref: "stable", sha: "b".repeat(40) },
    });
    expect(existsSync(join(installedPluginDir(stateDir, "demo"), "skills", "review", "SKILL.md"))).toBe(true);
    // The work copy is gone and nothing else is left in the cache.
    expect(existsSync(join(stateDir, "plugins", "cache")) ? readdirSync(join(stateDir, "plugins", "cache")) : []).toEqual([]);
  });

  it("installs from a separate repo, sub-folder and pinned commit", async () => {
    const mk = writeMarketplace(join(base, "mk"), [
      { name: "demo", source: { source: "git-subdir", url: "https://github.com/acme/mono.git", path: "plugins/demo", ref: "main", sha: "c".repeat(40) } },
    ]);
    const mono = join(base, "mono");
    writeClaudePlugin(join(mono, "plugins", "demo"));
    const { fetcher, calls } = fakeFetcher({ "https://github.com/acme/mono.git": mono });
    await addMarketplace(stateDir, mk, { fetcher });
    const res = await installMarketplacePlugin(stateDir, "demo", { fetcher });
    expect(calls).toEqual([{ url: "https://github.com/acme/mono.git", ref: "main", sha: "c".repeat(40) }]);
    expect(res.record.source).toMatchObject({ kind: "marketplace", marketplace: "acme", entry: "demo", sha: "c".repeat(40) });
  });

  it("writes plugin.json from a strict:false entry", async () => {
    const mk = writeMarketplace(join(base, "mk"), [{ name: "bundle", description: "Skills only", version: "0.3.0", source: "./skills", strict: false, skills: ["./one"] }]);
    mkdirSync(join(mk, "skills", "one"), { recursive: true });
    writeFileSync(join(mk, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: One\n---\nBody\n");
    const { fetcher } = fakeFetcher({});
    await addMarketplace(stateDir, mk, { fetcher });
    const res = await installMarketplacePlugin(stateDir, "bundle@acme", { fetcher });
    expect(res.record).toMatchObject({ name: "bundle", version: "0.3.0" });
    const bundle = readPluginBundle(installedPluginDir(stateDir, "bundle"));
    expect(bundle.skills.map(s => s.name)).toEqual(["one"]);
    // The user's marketplace folder was not written to.
    expect(existsSync(join(mk, "skills", ".claude-plugin"))).toBe(false);
  });

  it("refuses command and npm sources and paths that leave the marketplace", async () => {
    const mk = writeMarketplace(join(base, "mk"), [
      { name: "cmd", source: { source: "command", command: "touch /tmp/pwned" } },
      { name: "pkg", source: { source: "npm", package: "x" } },
    ]);
    const { fetcher, calls } = fakeFetcher({});
    await addMarketplace(stateDir, mk, { fetcher });
    await expect(installMarketplacePlugin(stateDir, "cmd@acme", { fetcher })).rejects.toThrow(/running a command/);
    await expect(installMarketplacePlugin(stateDir, "pkg@acme", { fetcher })).rejects.toThrow(/not supported/);
    expect(calls).toEqual([]);
  });

  it("asks to pick when a bare name is in two marketplaces", async () => {
    const a = writeMarketplace(join(base, "a"), [{ name: "demo", source: "./demo" }], "first");
    const b = writeMarketplace(join(base, "b"), [{ name: "demo", source: "./demo" }], "second");
    const { fetcher } = fakeFetcher({});
    await addMarketplace(stateDir, a, { fetcher });
    await addMarketplace(stateDir, b, { fetcher });
    expect(() => resolveMarketplacePlugin(stateDir, "demo")).toThrow(/demo@first, demo@second/);
    expect(resolveMarketplacePlugin(stateDir, "demo@second").marketplace.record.name).toBe("second");
    expect(() => resolveMarketplacePlugin(stateDir, "nope")).toThrow(/no added marketplace/);
  });

  it("refuses to add the same marketplace name twice", async () => {
    const mk = writeMarketplace(join(base, "mk"), []);
    const { fetcher } = fakeFetcher({});
    await addMarketplace(stateDir, mk, { fetcher });
    await expect(addMarketplace(stateDir, mk, { fetcher })).rejects.toThrow(/already added/);
  });

  it("adds a bare marketplace.json URL; relative plugins in it cannot be installed", async () => {
    const url = "https://example.com/marketplace.json";
    const text = JSON.stringify({ name: "remote", plugins: [{ name: "demo", source: "./demo" }] });
    const { fetcher } = fakeFetcher({}, {}, { [url]: text });
    const { record } = await addMarketplace(stateDir, url, { fetcher });
    expect(record).toMatchObject({ name: "remote", source: { kind: "url", url } });
    expect(listMarketplaces(stateDir)[0]?.manifest?.plugins).toHaveLength(1);
    await expect(installMarketplacePlugin(stateDir, "demo@remote", { fetcher })).rejects.toThrow(/bare URL/);
  });

  it("updates a marketplace and then the plugin; same commit means up to date", async () => {
    const url = "https://github.com/acme/market.git";
    const repo = writeMarketplace(join(base, "repo"), [{ name: "demo", source: "./plugins/demo" }]);
    writeClaudePlugin(join(repo, "plugins", "demo"));
    const shas = { [url]: "1".repeat(40) };
    const { fetcher } = fakeFetcher({ [url]: repo }, shas);
    await addMarketplace(stateDir, "acme/market", { fetcher, cwd: base });
    await installMarketplacePlugin(stateDir, "demo@acme", { fetcher });

    expect(await updatePlugin(stateDir, "demo", { fetcher })).toMatchObject({ status: "up-to-date" });

    shas[url] = "2".repeat(40);
    writeClaudePlugin(join(repo, "plugins", "demo"), { manifest: { version: "1.3.0" } });
    const [res] = await updateMarketplaces(stateDir, "acme", { fetcher });
    expect(res).toMatchObject({ name: "acme", previousSha: "1".repeat(40), sha: "2".repeat(40), changed: true });
    const up = await updatePlugin(stateDir, "demo", { fetcher, refreshMarketplace: false });
    expect(up).toMatchObject({ status: "updated", record: { version: "1.3.0", source: { sha: "2".repeat(40) } }, previous: { version: "1.2.0" } });
  });

  it("an update keeps the old copy when the review says no", async () => {
    const mk = writeMarketplace(join(base, "mk"), [{ name: "demo", source: "./demo" }]);
    writeClaudePlugin(join(mk, "demo"));
    const { fetcher } = fakeFetcher({});
    await addMarketplace(stateDir, mk, { fetcher });
    await installMarketplacePlugin(stateDir, "demo@acme", { fetcher });
    writeClaudePlugin(join(mk, "demo"), { manifest: { version: "9.9.9" } });
    const seen: string[] = [];
    await expect(updatePlugin(stateDir, "demo", {
      fetcher,
      review: async (staged, ctx) => {
        seen.push(`${ctx.mode}:${ctx.previous?.version}->${staged.bundle.manifest.version}:${ctx.previousBundle?.name}`);
        throw new PluginInstallError("cancelled");
      },
    })).rejects.toThrow("cancelled");
    expect(seen).toEqual(["update:1.2.0->9.9.9:demo"]);
    expect(readPluginState(stateDir).plugins.demo?.version).toBe("1.2.0");
    expect(readPluginBundle(installedPluginDir(stateDir, "demo")).manifest.version).toBe("1.2.0");
  });

  it("the review decides enabled and runsCodeAccepted on install", async () => {
    const mk = writeMarketplace(join(base, "mk"), [{ name: "demo", source: "./demo" }]);
    writeClaudePlugin(join(mk, "demo"), { hooks: true });
    const { fetcher } = fakeFetcher({});
    await addMarketplace(stateDir, mk, { fetcher });
    const res = await installMarketplacePlugin(stateDir, "demo@acme", { fetcher, review: async () => ({ enabled: false, runsCodeAccepted: false }) });
    expect(res.record).toMatchObject({ enabled: false, runsCodeAccepted: false });
  });

  it("removing a marketplace deletes its checkout and reports plugins still installed", async () => {
    const url = "https://github.com/acme/market.git";
    const repo = writeMarketplace(join(base, "repo"), [{ name: "demo", source: "./plugins/demo" }]);
    writeClaudePlugin(join(repo, "plugins", "demo"));
    const { fetcher } = fakeFetcher({ [url]: repo });
    await addMarketplace(stateDir, "acme/market", { fetcher, cwd: base });
    await installMarketplacePlugin(stateDir, "demo@acme", { fetcher });
    expect(removeMarketplace(stateDir, "acme")).toEqual({ removed: true, plugins: ["demo"] });
    expect(existsSync(join(stateDir, "plugins", "marketplaces", "acme"))).toBe(false);
    expect(readPluginState(stateDir).plugins.demo).toBeDefined();
    expect(removeMarketplace(stateDir, "acme").removed).toBe(false);
  });

  it("tells a folder from a plugin spec", () => {
    mkdirSync(join(base, "folder"));
    expect(looksLikePluginSpec("folder", base)).toBe(false);
    expect(looksLikePluginSpec("demo@acme", base)).toBe(true);
    expect(looksLikePluginSpec("demo", base)).toBe(true);
    expect(looksLikePluginSpec("./missing/dir", base)).toBe(false);
  });

  it("does not touch the user's local marketplace folder", async () => {
    const mk = writeMarketplace(join(base, "mk"), [{ name: "demo", source: "./demo" }]);
    writeClaudePlugin(join(mk, "demo"));
    const before = readFileSync(join(mk, ".claude-plugin", "marketplace.json"), "utf8");
    const { fetcher } = fakeFetcher({});
    await addMarketplace(stateDir, mk, { fetcher });
    await installMarketplacePlugin(stateDir, "demo@acme", { fetcher });
    removeMarketplace(stateDir, "acme");
    expect(readFileSync(join(mk, ".claude-plugin", "marketplace.json"), "utf8")).toBe(before);
  });
});

