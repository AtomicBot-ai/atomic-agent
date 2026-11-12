/**
 * The npm distribution, the pure part: which packages a release becomes, what
 * their manifests say and the order they are published in. `npm-packages.ts`
 * does the file system; this module has no I/O so `npm-packaging.test.ts` can
 * cover it.
 *
 * Layout (the approach Codex and esbuild use): the package `atomic-agent` is a
 * small launcher whose `bin` is `atag` (and `atomic-agent`), and one package
 * per release target, `@atomicbot/atag-<slug>`, carries that target's release
 * bundle (`atomic-agent-<slug>.tar.gz|zip`) unpacked: the SEA binary and the
 * directories the runtime resolves next to it. The launcher lists every
 * platform package as an optionalDependency with `os` and `cpu` set, so npm
 * downloads only the one for the machine, and runs its binary in place.
 *
 * The bundle's `node_modules/` (better-sqlite3 with its prebuilt addon,
 * bindings, file-uri-to-path, playwright-core) must stay next to the binary.
 * npm leaves a package's own `node_modules/` out of the tarball unless the
 * packages are listed in `bundleDependencies`, so they are listed there, and
 * in `dependencies` at their exact versions (a bundled package missing from
 * `dependencies` is pruned at install as extraneous). Their manifests are
 * stripped of install scripts and of dependencies that are not bundled: npm
 * would otherwise run better-sqlite3's `prebuild-install || node-gyp rebuild`
 * and replace the addon built for the SEA's Node with one for the user's.
 */
import { BUNDLE_TARGETS, type BundleTarget } from "./bundle-targets.js";

export const LAUNCHER_PACKAGE = "atomic-agent";
export const PLATFORM_SCOPE = "@atomicbot";
export const GITHUB_REPO = "AtomicBot-ai/atomic-agent";

/** `@atomicbot/atag-<slug>`; packaging/npm/atomic-agent/lib/platform.js must agree. */
export function platformPackageName(slug: string): string {
  return `${PLATFORM_SCOPE}/atag-${slug}`;
}

/** The release asset a platform package is made from. */
export function archiveName(target: BundleTarget): string {
  return `atomic-agent-${target.slug}.${target.archiveExt}`;
}

/** The release target of a slug, or throws for an unknown one. */
export function targetForSlug(slug: string): BundleTarget {
  const target = BUNDLE_TARGETS.find((t) => t.slug === slug);
  if (!target) {
    throw new Error(
      `unknown target "${slug}"; known: ${BUNDLE_TARGETS.map((t) => t.slug).join(", ")}`,
    );
  }
  return target;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** The npm version of a CLI release tag (`v0.7.1` → `0.7.1`), or throws. */
export function versionFromTag(tag: string): string {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!SEMVER.test(version)) {
    throw new Error(`"${tag}" is not a CLI release tag (vX.Y.Z)`);
  }
  return version;
}

/** A pre-release goes to the `next` dist-tag, so `npm i -g atomic-agent` never picks it. */
export function distTag(version: string): "latest" | "next" {
  return /^[^+]*-/.test(version) ? "next" : "latest";
}

export type Manifest = Record<string, unknown>;

/**
 * A bundled dependency's manifest with nothing npm would act on at install:
 * no lifecycle scripts, no `gypfile` (which makes npm run node-gyp itself),
 * and only the dependencies that are bundled too.
 */
export function sanitizeBundledManifest(
  manifest: Manifest,
  bundled: ReadonlySet<string>,
): Manifest {
  const out: Manifest = { ...manifest };
  delete out.scripts;
  delete out.gypfile;
  delete out.devDependencies;
  delete out.peerDependencies;
  delete out.peerDependenciesMeta;
  delete out.optionalDependencies;
  const deps = manifest.dependencies;
  if (deps && typeof deps === "object") {
    const kept = Object.fromEntries(
      Object.entries(deps as Record<string, string>).filter(([name]) => bundled.has(name)),
    );
    if (Object.keys(kept).length > 0) out.dependencies = kept;
    else delete out.dependencies;
  }
  return out;
}

const REPOSITORY = {
  type: "git",
  url: `git+https://github.com/${GITHUB_REPO}.git`,
};

/** The manifest of `@atomicbot/atag-<slug>`. */
export function platformManifest(input: {
  slug: string;
  version: string;
  /** Bundled packages under the tree's node_modules/, name → version. */
  bundled: Readonly<Record<string, string>>;
}): Manifest {
  const target = targetForSlug(input.slug);
  const names = Object.keys(input.bundled).sort();
  return {
    name: platformPackageName(target.slug),
    version: input.version,
    description: `The ${target.slug} binary of atomic-agent. Install atomic-agent instead; it picks this package for you.`,
    license: "MIT",
    homepage: "https://atomicagent.io",
    repository: REPOSITORY,
    os: [target.platform],
    cpu: [target.arch],
    // The binary and better_sqlite3.node need glibc 2.34 (the Linux packages' floor).
    ...(target.platform === "linux" ? { libc: ["glibc"] } : {}),
    preferUnplugged: true,
    dependencies: Object.fromEntries(names.map((name) => [name, input.bundled[name]!])),
    bundleDependencies: names,
  };
}

/** The launcher's manifest: the template in packaging/npm with this release filled in. */
export function launcherManifest(
  template: Manifest,
  version: string,
  slugs: readonly string[],
): Manifest {
  if (slugs.length === 0) throw new Error("no platform packages to depend on");
  const optional = Object.fromEntries(
    [...slugs].sort().map((slug) => [platformPackageName(targetForSlug(slug).slug), version]),
  );
  return { ...template, name: LAUNCHER_PACKAGE, version, optionalDependencies: optional };
}

/**
 * Package directories in publish order: every platform package before the
 * launcher, so `npm i -g atomic-agent` never sees a launcher whose platform
 * package is not there yet.
 */
export function publishOrder(slugs: readonly string[]): string[] {
  return [...[...slugs].sort(), LAUNCHER_PACKAGE];
}
