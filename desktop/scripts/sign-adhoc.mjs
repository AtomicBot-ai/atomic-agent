/**
 * Ad-hoc sign the packaged app under ITS OWN identifier.
 *
 * electron-builder with `mac.identity: null` does not sign at all, so the
 * bundle keeps the signature Electron shipped with — and `codesign -dvvv`
 * on the result reports `Identifier=Electron`.
 *
 * macOS attributes a TCC permission (microphone, camera, screen recording)
 * to the code-signature identity, not to the bundle id in Info.plist. So a
 * grant the operator gives to "Atomic Agent" is recorded against the
 * identifier `Electron`, which is not what this app asks with — and every
 * other unsigned Electron app on the machine shares it. The operator sees
 * the app listed and switched ON in System Settings while getUserMedia
 * still fails, which surfaces as `AbortError`: the OS refuses to start the
 * device rather than prompting again.
 *
 * Ad-hoc signing with an explicit identifier makes the app ask under its
 * own name. It does NOT make the identity stable across builds — an ad-hoc
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
/** The agent bundle built by `npm run bundle:package` at the repo root. */
const AGENT_SRC = join(HERE, "..", "..", "bundle", "darwin-arm64");

/**
 * Put the matching agent inside the app.
 *
 * This is deliberately NOT an `extraResources` entry. electron-builder has
 * its own handling for anything called `node_modules` and drops the tree on
 * the floor: the agent arrived without `better-sqlite3`, its anchored
 * `createRequire` then walked up out of the bundle, found the copy in the
 * checkout this app happened to be built inside — compiled for a different
 * Node ABI — and `atag serve` died on `NODE_MODULE_VERSION`. The packaged
 * suite caught it as `agent connected — state=error` on check 8.
 *
 * Copying here, after the pack and before the signature, keeps the whole
 * tree and gets it covered by the same ad-hoc signature as the rest.
 */
function copyAgent(appPath) {
  const dest = join(appPath, "Contents", "Resources", "agent");
  if (!existsSync(AGENT_SRC)) {
    throw new Error(
      `no agent bundle at ${AGENT_SRC} — build it first:\n`
      + "  npm run build && npm run bundle:sea && npm run bundle:fetch-assets\n"
      + "  npm run bundle:build-binary && npm run bundle:package   (Node >= 25.7)",
    );
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(AGENT_SRC, dest, { recursive: true, preserveTimestamps: true });
  const probe = join(dest, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!existsSync(probe)) {
    throw new Error(`the agent copy is missing its native module: ${probe}`);
  }
  /* PRESENT is not the same as LOADABLE.
     `better-sqlite3` is a native module and the SEA embeds its own Node, so
     the two have to agree on the ABI. They did not: the repo's node_modules
     carries a build for the Node that ran `npm install` (22, ABI 127) while
     the SEA embeds Node 25 (ABI 141), and the module only fails when
     something opens a store — which the app does on its first turn, not at
     startup. Shipped, it looked like a working DMG until the agent died with
     `NODE_MODULE_VERSION 141` and the window said `state=error`.

     So the build asks the agent to do something that opens sqlite. `task
     list` is the cheapest: it exits 0 and prints "(no tasks)" on a throwaway
     state directory, and exits 1 naming NODE_MODULE_VERSION when the module
     is wrong. A broken agent fails the BUILD now instead of the user. */
  const probeDir = mkdtempSync(join(tmpdir(), "atag-agent-abi-"));
  try {
    const agentBin = join(dest, "atomic-agent");
    const run = spawnSync(agentBin, ["task", "list"], {
      env: { ...process.env, ATOMIC_AGENT_STATE_DIR: probeDir },
      encoding: "utf8",
      timeout: 120_000,
    });
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    if (run.status !== 0) {
      throw new Error(
        `the bundled agent cannot open its own database — this DMG would ship broken.\n`
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
  console.log(`agent → ${dest} (opens its database)`);
}

export default async function signAdhoc(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  const id = context.packager.appInfo.id; // ai.atomicbot.desktop
  copyAgent(appPath);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--identifier", id, appPath], { stdio: "inherit" });
  /* `codesign -dvvv` writes its report to STDERR, not stdout — reading
     stdout returns an empty string and the check below then fails a build
     that actually signed correctly. */
  let report = "";
  try {
    execFileSync("codesign", ["-dvvv", appPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    report = String(err?.stderr ?? "");
  }
  if (!report) {
    const res = spawnSync("codesign", ["-dvvv", appPath], { encoding: "utf8" });
    report = `${res.stderr ?? ""}${res.stdout ?? ""}`;
  }
  const line = report.split("\n").find((l) => l.startsWith("Identifier=")) ?? "(no Identifier line)";
  console.log(`ad-hoc signed ${appPath} → ${line}`);
  if (!line.includes(id)) throw new Error(`ad-hoc sign did not take: ${line}`);
}
