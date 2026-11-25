import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ACP_ARGS,
  archiveCommand,
  buildAcpManifest,
  renderAcpManifest,
  validateAcpIcon,
  validateAcpManifest,
} from "./acp-registry-manifest.js";
import { BUNDLE_TARGETS } from "./bundle-targets.js";

/** ATO-689: the ACP registry entry and the registry CI's offline checks. */
const HASH = "a1f8d4bec9f12873c06cf8388a90cb998aab5f0c133f4c036c2fd15d41f51472";
const RELEASED = {
  "darwin-arm64": HASH,
  "linux-x64": HASH,
  "linux-arm64": HASH,
  "win32-x64": HASH.toUpperCase(),
};

describe("ACP registry manifest", () => {
  it("lists one binary target per released archive, pinned to the release and its sha256", () => {
    const manifest = buildAcpManifest({ version: "v0.7.0", sha256: RELEASED });
    expect(manifest.id).toBe("atomic-agent");
    expect(manifest.version).toBe("0.7.0");
    expect(manifest.license).toBe("MIT");
    expect(Object.keys(manifest.distribution.binary).sort()).toEqual([
      "darwin-aarch64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-x86_64",
    ]);
    expect(manifest.distribution.binary["darwin-aarch64"]).toEqual({
      archive: "https://github.com/AtomicBot-ai/atomic-agent/releases/download/v0.7.0/atomic-agent-darwin-arm64.tar.gz",
      sha256: HASH,
      cmd: "./darwin-arm64/atomic-agent",
      args: [...ACP_ARGS],
    });
    expect(manifest.distribution.binary["windows-x86_64"]).toMatchObject({
      archive: "https://github.com/AtomicBot-ai/atomic-agent/releases/download/v0.7.0/atomic-agent-win32-x64.zip",
      sha256: HASH,
      cmd: "./atomic-agent.exe",
    });
    expect(validateAcpManifest(manifest)).toEqual([]);
    expect(renderAcpManifest(manifest).endsWith("}\n")).toBe(true);
  });

  it("finds the executable where package-bundle.ts puts it in each archive", () => {
    const commands = Object.fromEntries(BUNDLE_TARGETS.map((t) => [t.slug, archiveCommand(t)]));
    expect(commands).toEqual({
      "darwin-arm64": "./darwin-arm64/atomic-agent",
      "darwin-x64": "./darwin-x64/atomic-agent",
      "linux-x64": "./linux-x64/atomic-agent",
      "linux-arm64": "./linux-arm64/atomic-agent",
      "win32-x64": "./atomic-agent.exe",
    });
  });

  it("refuses a prerelease version, an unknown slug and no digests at all", () => {
    expect(() => buildAcpManifest({ version: "0.7.0-rc.1", sha256: RELEASED })).toThrow(/X\.Y\.Z/);
    expect(() => buildAcpManifest({ version: "0.7.0", sha256: { "freebsd-x64": HASH } })).toThrow(/unknown bundle/);
    expect(() => buildAcpManifest({ version: "0.7.0", sha256: {} })).toThrow(/no archive digests/);
  });
});

describe("registry checks on agent.json", () => {
  const good = () => JSON.parse(JSON.stringify(buildAcpManifest({ version: "0.7.0", sha256: RELEASED }))) as Record<string, any>;

  it("catches what the registry CI rejects", () => {
    const noLicense = good();
    delete noLicense.license_url;
    expect(validateAcpManifest(noLicense).join("\n")).toMatch(/license_url/);

    expect(validateAcpManifest(good(), "other-folder").join("\n")).toMatch(/must match its folder/);

    const badVersion = good();
    badVersion.version = "0.7";
    expect(validateAcpManifest(badVersion).join("\n")).toMatch(/X\.Y\.Z/);

    const stale = good();
    stale.version = "0.7.1";
    expect(validateAcpManifest(stale).join("\n")).toMatch(/is version 0\.7\.0, the entry is 0\.7\.1/);

    const latest = good();
    latest.distribution.binary["linux-x86_64"].archive =
      "https://github.com/AtomicBot-ai/atomic-agent/releases/latest/download/atomic-agent-linux-x64.tar.gz";
    expect(validateAcpManifest(latest).join("\n")).toMatch(/latest/);

    const installer = good();
    installer.distribution.binary["linux-x86_64"].archive =
      "https://github.com/AtomicBot-ai/atomic-agent/releases/download/v0.7.0/atomic-agent_0.7.0_amd64.deb";
    expect(validateAcpManifest(installer).join("\n")).toMatch(/installer/);

    const badPlatform = good();
    badPlatform.distribution.binary["macos-arm64"] = badPlatform.distribution.binary["darwin-aarch64"];
    expect(validateAcpManifest(badPlatform).join("\n")).toMatch(/unknown platform/);

    const badHash = good();
    badHash.distribution.binary["darwin-aarch64"].sha256 = "abc";
    expect(validateAcpManifest(badHash).join("\n")).toMatch(/64 hex/);

    const extra = good();
    extra.homepage = "https://atomicagent.io";
    expect(validateAcpManifest(extra).join("\n")).toMatch(/unknown field "homepage"/);

    const noDistribution = good();
    noDistribution.distribution = {};
    expect(validateAcpManifest(noDistribution).join("\n")).toMatch(/at least one/);
  });
});

describe("registry checks on icon.svg", () => {
  it("passes the checked-in icon", () => {
    const svg = readFileSync(new URL("../packaging/acp-registry/icon.svg", import.meta.url), "utf8");
    expect(validateAcpIcon(svg)).toEqual([]);
  });

  it("rejects a wrong size, a non-square icon and hardcoded colors", () => {
    expect(validateAcpIcon('<svg width="64" height="64"><path fill="currentColor"/></svg>').join("\n")).toMatch(/16x16/);
    expect(validateAcpIcon('<svg viewBox="0 0 16 12"><path fill="none"/></svg>').join("\n")).toMatch(/square/);
    expect(validateAcpIcon('<svg width="16" height="16"><rect fill="#006AFF"/></svg>').join("\n")).toMatch(/hardcoded/);
    expect(validateAcpIcon('<svg width="16" height="16"><path style="stroke: red"/></svg>').join("\n")).toMatch(/hardcoded/);
    expect(validateAcpIcon("<div/>")).toEqual(["icon.svg has no <svg> element"]);
  });
});
