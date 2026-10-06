/**
 * electron-builder `afterPack` hook, run once per packed platform/arch
 * before any installer (DMG, NSIS, AppImage, deb) is made from it:
 *
 *   1. copy the matching agent bundle into <resources>/agent  (every target)
 *   2. prove the copy can open its own database                (host == target;
 *      win32-arm64 packed on x64 is probed in CI's agent-win32-arm64 job)
 *   3. ad-hoc sign the .app under its own identifier            (macOS only)
 *
 * The agent comes from `../bundle/<slug>` at the repo root, where the
 * release pipeline stages it (`npm run bundle:package <slug>`). The slugs are
 * the release matrix ones from .github/workflows/release.yml and
 * scripts/bundle-targets.ts: darwin-arm64, win32-x64, win32-arm64, linux-x64,
 * linux-arm64. win32-arm64 is built by the desktop workflow only
 * (.github/workflows/desktop.yml); the terminal CLI release does not ship it.
 *
 * Why step 3 exists. electron-builder with `mac.identity: null` does not sign
 * at all, so the bundle keeps the signature Electron shipped with, and
 * `codesign -dvvv` on the result reports `Identifier=Electron`.
 *
 * macOS attributes a TCC permission (microphone, camera, screen recording)
 * to the code-signature identity, not to the bundle id in Info.plist. So a
 * grant the operator gives to "Atomic Agent" is recorded against the
 * identifier `Electron`, which is not what this app asks with, and every
 * other unsigned Electron app on the machine shares it. The operator sees
 * the app listed and switched ON in System Settings while getUserMedia
 * still fails, which surfaces as `AbortError`: the OS refuses to start the
 * device rather than prompting again.
 *
 * Ad-hoc signing with an explicit identifier makes the app ask under its
 * own name. It does NOT make the identity stable across builds: an ad-hoc
 * designated requirement pins the cdhash, so a rebuilt app is a new
 * identity and macOS will ask again. That is inherent to shipping unsigned;
 * a Developer ID certificate is the only thing that fixes it properly, and
 * the README says so rather than pretending otherwise.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Where `npm run bundle:package <slug>` stages each agent bundle. */
const BUNDLE_ROOT = join(HERE, "..", "..", "bundle");

/** electron-builder's `Arch` enum (builder-util), by value. */
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

/** The agent release targets the desktop app can ship with. */
const SUPPORTED = new Set([
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
]);

function targetOf(context) {
  const platform = context.electronPlatformName; // darwin | win32 | linux | mas
  const arch = ARCH_NAMES[context.arch] ?? String(context.arch);
  const slug = `${platform}-${arch}`;
  if (!SUPPORTED.has(slug)) {
    throw new Error(
      `no agent bundle is built for ${slug}. The desktop app ships for `
      + `${[...SUPPORTED].join(", ")}; pick one of those with --mac/--win/--linux and --x64/--arm64.`,
    );
  }
  const exe = platform === "win32" ? "atomic-agent.exe" : "atomic-agent";
  return { platform, arch, slug, exe };
}

/** The directory electron-builder treats as `process.resourcesPath`. */
function resourcesDir(context, platform) {
  if (platform === "darwin") {
    return join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return join(context.appOutDir, "resources"); // win-unpacked/, win-arm64-unpacked/, linux-unpacked/, linux-arm64-unpacked/
}

/**
 * Put the matching agent inside the app.
 *
 * This is deliberately NOT an `extraResources` entry. electron-builder has
 * its own handling for anything called `node_modules` and drops the tree on
 * the floor: the agent arrived without `better-sqlite3`, its anchored
 * `createRequire` then walked up out of the bundle, found the copy in the
 * checkout this app happened to be built inside (compiled for a different
 * Node ABI) and `atag serve` died on `NODE_MODULE_VERSION`. The packaged
 * suite caught it as `agent connected, state=error` on check 8.
 *
 * Copying here, after the pack and before the signature, keeps the whole
 * tree and (on macOS) gets it covered by the same ad-hoc signature.
 */
function copyAgent(context, target) {
  const src = join(BUNDLE_ROOT, target.slug);
  const dest = join(resourcesDir(context, target.platform), "agent");
  if (!existsSync(join(src, target.exe))) {
    throw new Error(
      `no ${target.slug} agent bundle at ${src} (expected ${target.exe} inside).\n`
      + "Build it at the repo root ON a " + target.slug + " machine (natives and the SEA are per-platform):\n"
      + "  npm ci && npm run build && npm run bundle:sea && npm run bundle:fetch-assets\n"
      + `  npm run bundle:build-binary && npx tsx scripts/package-bundle.ts ${target.slug}   (Node >= 25.7)`,
    );
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, preserveTimestamps: true });
  const probe = join(dest, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!existsSync(probe)) {
    throw new Error(`the agent copy is missing its native module: ${probe}`);
  }
  probeDatabase(join(dest, target.exe), target);
  return dest;
}

/*
 * PRESENT is not the same as LOADABLE.
 * `better-sqlite3` is a native module and the SEA embeds its own Node, so
 * the two have to agree on the ABI. They did not once: the repo's
 * node_modules carried a build for the Node that ran `npm install` (22, ABI
 * 127) while the SEA embeds Node 25 (ABI 141), and the module only fails when
 * something opens a store, which the app does on its first turn, not at
 * startup. Shipped, it looked like a working DMG until the agent died with
 * `NODE_MODULE_VERSION 141` and the window said `state=error`.
 *
 * So the build asks the agent to do something that opens sqlite. `task
 * list` is the cheapest: it exits 0 and prints "(no tasks)" on a throwaway
 * state directory, and exits 1 naming NODE_MODULE_VERSION when the module
 * is wrong. A broken agent fails the BUILD now instead of the user.
 *
 * The probe can only run where the binary can: the host has to BE the
 * target. A local cross-pack (say a Linux AppImage from a Mac) says it
 * skipped. In CI every target is packed on its own platform and the probe
 * runs, with one exception (ATO-252): win32-arm64 is packed and signed on an
 * x64 Windows runner, because DigiCert's x64-only signing tools hang under
 * emulation on Windows on ARM. That bundle was built and probed natively by
 * the desktop workflow's agent-win32-arm64 job, so the skip is allowed for
 * exactly that pair; any other skip in CI fails the build.
 */
function probeDatabase(agentBin, target) {
  const host = `${process.platform}-${process.arch}`;
  if (process.platform !== target.platform || process.arch !== target.arch) {
    if (host === "win32-x64" && target.slug === "win32-arm64") {
      console.log(
        `agent database probe: skipped (host ${host} cannot run ${target.slug}); `
        + "in CI it ran on Windows on ARM in the agent-win32-arm64 job "
        + "(.github/workflows/desktop.yml), against this same bundle",
      );
      return;
    }
    if (process.env.CI) {
      throw new Error(
        `agent database probe: host ${host} cannot run ${target.slug}, and in CI every target `
        + "but win32-arm64 must be packed on its own platform so the bundled agent is probed.",
      );
    }
    console.log(`agent database probe: skipped (host ${host} cannot run ${target.slug})`);
    return;
  }
  const probeDir = mkdtempSync(join(tmpdir(), "atag-agent-abi-"));
  try {
    const run = spawnSync(agentBin, ["task", "list"], {
      env: { ...process.env, ATOMIC_AGENT_STATE_DIR: probeDir },
      encoding: "utf8",
      timeout: 120_000,
    });
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? String(run.error) : ""}`;
    if (run.status !== 0) {
      throw new Error(
        `the bundled agent cannot open its own database; this ${target.slug} build would ship broken.\n`
        + (/NODE_MODULE_VERSION/.test(said)
          ? "better-sqlite3 was built for a different Node than the SEA embeds. "
            + "Rebuild it against the SEA's Node (>= 25.7) and re-run bundle:package.\n"
          : "")
        + said.split("\n").slice(0, 6).join("\n"),
      );
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function signAdhoc(context) {
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id; // io.atomicagent.desktop
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--identifier", id, appPath], { stdio: "inherit" });
  /* `codesign -dvvv` writes its report to STDERR, not stdout: reading
     stdout returns an empty string and the check below then fails a build
     that actually signed correctly. */
  const res = spawnSync("codesign", ["-dvvv", appPath], { encoding: "utf8" });
  const report = `${res.stderr ?? ""}${res.stdout ?? ""}`;
  const line = report.split("\n").find((l) => l.startsWith("Identifier=")) ?? "(no Identifier line)";
  console.log(`ad-hoc signed ${appPath} → ${line}`);
  if (!line.includes(id)) throw new Error(`ad-hoc sign did not take: ${line}`);
}

export default async function afterPack(context) {
  const target = targetOf(context);
  const dest = copyAgent(context, target);
  console.log(`agent (${target.slug}) → ${dest}`);
  // electron-builder.cjs keeps `mac.identity: null`, so a local `npm run dist` is
  // ad-hoc signed here. CI overrides the identity with the Developer ID
  // certificate (.github/workflows/desktop.yml); electron-builder then signs
  // the app itself after this hook, and an ad-hoc pass first would be wasted.
  if (target.platform === "darwin" && context.packager.platformSpecificBuildOptions.identity === null) {
    signAdhoc(context);
  }
}
