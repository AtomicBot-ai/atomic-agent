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

export default async function signAdhoc(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  const id = context.packager.appInfo.id; // ai.atomicbot.desktop
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
