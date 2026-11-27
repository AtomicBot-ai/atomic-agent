import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanEgress } from "./egress-scan.js";
import { publishRegistryUrl } from "./publish-registry.js";

describe("publishRegistryUrl (ATO-2528)", () => {
  let root: string;
  let home: string;
  let project: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "publish-registry-"));
    home = join(root, "home");
    project = join(root, "work", "pkg");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads registry from the project .npmrc, then the user one, else nothing", () => {
    expect(publishRegistryUrl(project, "npm", undefined, home)).toBeUndefined();
    writeFileSync(join(home, ".npmrc"), "registry=https://user.example/\n");
    expect(publishRegistryUrl(project, "npm", undefined, home)).toBe("https://user.example/");
    writeFileSync(join(project, ".npmrc"), "; note\nregistry = https://npm.internal.example/\n");
    expect(publishRegistryUrl(project, "pnpm", undefined, home)).toBe("https://npm.internal.example/");
  });

  it("prefers publishConfig.registry, and a scope's own registry", () => {
    writeFileSync(join(project, ".npmrc"), "registry=https://a.example/\n@acme:registry=https://acme.example/\n");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "@acme/x" }));
    expect(publishRegistryUrl(project, "npm", undefined, home)).toBe("https://acme.example/");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "x", publishConfig: { registry: "https://p.example/" } }));
    expect(publishRegistryUrl(project, "npm", undefined, home)).toBe("https://p.example/");
  });

  it("is null for a registry built from a variable", () => {
    writeFileSync(join(project, ".npmrc"), "registry=${REGISTRY_URL}\n");
    expect(publishRegistryUrl(project, "npm", undefined, home)).toBeNull();
  });

  it("reads a named cargo registry in both table forms, and the default one", () => {
    mkdirSync(join(project, ".cargo"));
    writeFileSync(
      join(project, ".cargo", "config.toml"),
      '[registry]\ndefault = "corp"\n\n[registries.corp]\nindex = "sparse+https://cargo.corp.example/index/"\n',
    );
    expect(publishRegistryUrl(project, "cargo", "corp", home)).toBe("https://cargo.corp.example/index/");
    expect(publishRegistryUrl(project, "cargo", undefined, home)).toBe("https://cargo.corp.example/index/");
    mkdirSync(join(home, ".cargo"));
    writeFileSync(join(home, ".cargo", "config.toml"), '[registries]\nmine = { index = "https://git.mine.example/index" }\n');
    expect(publishRegistryUrl(project, "cargo", "mine", home)).toBe("https://git.mine.example/index");
    expect(publishRegistryUrl(project, "cargo", "nowhere", home)).toBeNull();
  });

  it("feeds the egress scan: npm publish names the configured registry, a flag still wins", () => {
    const resolver = () => "https://npm.internal.example/";
    expect(scanEgress([["npm", "publish"]], { publishRegistry: resolver })[0]?.host).toBe("npm.internal.example");
    expect(scanEgress([["npm", "publish", "--registry", "https://r.example"]], { publishRegistry: resolver })[0]?.host).toBe(
      "r.example",
    );
    expect(scanEgress([["npm", "publish"]])[0]?.host).toBe("registry.npmjs.org");
    expect(scanEgress([["cargo", "publish", "--registry", "corp"]], { publishRegistry: () => "https://c.example/i" })[0]?.host).toBe(
      "c.example",
    );
    expect(scanEgress([["npm", "publish"]], { publishRegistry: () => null })[0]?.host).toBeNull();
  });

  // Review round 1: the card named the cwd registry for forms that use another.
  it("is unknown for a folder or tarball operand, which publishes with its own publishConfig", () => {
    const resolver = () => "https://registry.npmjs.org/";
    for (const words of [
      ["npm", "publish", "./pkg"],
      ["npm", "publish", "--tag", "beta", "x-1.0.0.tgz"],
      ["pnpm", "publish", "packages/a"],
      ["yarn", "npm", "publish", "./pkg"],
    ]) {
      expect(scanEgress([words], { publishRegistry: resolver })[0]?.host, words.join(" ")).toBeNull();
    }
    expect(scanEgress([["npm", "publish", "."]], { publishRegistry: resolver })[0]?.host).toBe("registry.npmjs.org");
    expect(scanEgress([["npm", "publish", "--tag", "beta"]], { publishRegistry: resolver })[0]?.host).toBe(
      "registry.npmjs.org",
    );
  });

  it("is unknown after a cd on the same line, not the public default", () => {
    const resolver = () => undefined;
    expect(scanEgress([["cd", "pkg"], ["npm", "publish"]], { publishRegistry: resolver })[0]?.host).toBeNull();
  });

  it("reads .yarnrc.yml for yarn 2+, which ignores .npmrc", () => {
    writeFileSync(join(project, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    writeFileSync(join(project, ".yarnrc.yml"), "nodeLinker: node-modules\nnpmPublishRegistry: \"https://evil.example/\"\n");
    expect(publishRegistryUrl(project, "yarn", undefined, home)).toBe("https://evil.example/");
    expect(publishRegistryUrl(project, "npm", undefined, home)).toBe("https://registry.npmjs.org/");
    writeFileSync(join(project, ".yarnrc.yml"), "npmRegistryServer: https://mirror.example\n");
    expect(publishRegistryUrl(project, "yarn", undefined, home)).toBe("https://mirror.example");
    writeFileSync(join(project, ".yarnrc.yml"), "nodeLinker: pnp\n");
    expect(publishRegistryUrl(project, "yarn", undefined, home)).toBeUndefined();
    writeFileSync(join(project, ".yarnrc.yml"), "npmScopes:\n  acme:\n    npmRegistryServer: https://acme.example\n");
    expect(publishRegistryUrl(project, "yarn", undefined, home)).toBeNull();
  });
});
