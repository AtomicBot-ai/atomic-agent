import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { BUNDLE_TARGETS } from "./bundle-targets.js";

// packaging/aqua/registry.yaml names the release assets with aqua's templates. Rendering them
// the way aqua does (GOOS/GOARCH through `replacements`) must land on the archives
// package-bundle.ts writes, or `aqua install` 404s.
interface AquaFile {
  name: string;
  src: string;
}
interface AquaPackage {
  asset: string;
  format: string;
  replacements: Record<string, string>;
  files: AquaFile[];
  overrides: { goos: string; format?: string; files?: AquaFile[] }[];
  supported_envs: string[];
  version_filter: string;
  checksum: { asset: string };
}
const pkg = (
  parse(readFileSync(new URL("../packaging/aqua/registry.yaml", import.meta.url), "utf8")) as {
    packages: AquaPackage[];
  }
).packages[0]!;

const GO_OS: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const GO_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

function render(template: string, goos: string, goarch: string, format: string): string {
  const os = pkg.replacements[goos] ?? goos;
  const arch = pkg.replacements[goarch] ?? goarch;
  return template.replaceAll("{{.OS}}", os).replaceAll("{{.Arch}}", arch).replaceAll("{{.Format}}", format);
}

function supported(goos: string, goarch: string): boolean {
  return pkg.supported_envs.some((env) => env === goos || env === `${goos}/${goarch}`);
}

describe("aqua registry entry", () => {
  const targets = BUNDLE_TARGETS.map((t) => ({ t, goos: GO_OS[t.platform]!, goarch: GO_ARCH[t.arch]! }));

  it("renders each supported platform's asset to the bundle archive name", () => {
    for (const { t, goos, goarch } of targets.filter((x) => supported(x.goos, x.goarch))) {
      const override = pkg.overrides.find((o) => o.goos === goos);
      const format = override?.format ?? pkg.format;
      expect(render(pkg.asset, goos, goarch, format)).toBe(`atomic-agent-${t.slug}.${t.archiveExt}`);
    }
  });

  it("points the files at the binary inside the archive (a <slug>/ directory, the zip's root)", () => {
    for (const { t, goos, goarch } of targets.filter((x) => supported(x.goos, x.goarch))) {
      const files = pkg.overrides.find((o) => o.goos === goos)?.files ?? pkg.files;
      const src = files.find((f) => f.name === "atomic-agent")!.src;
      const expected = t.platform === "win32" ? "atomic-agent" : `${t.slug}/atomic-agent`;
      expect(render(src, goos, goarch, "")).toBe(expected);
    }
  });

  it("lists CLI tags only, not the desktop app's", () => {
    const regex = new RegExp(/"(.*)"/.exec(pkg.version_filter)![1]!.replaceAll("\\\\", "\\"));
    expect(regex.test("v0.7.0")).toBe(true);
    expect(regex.test("desktop-v0.0.8")).toBe(false);
  });

  it("checks the digest the release puts beside each asset", () => {
    expect(pkg.checksum.asset).toBe("{{.Asset}}.sha256");
  });
});
