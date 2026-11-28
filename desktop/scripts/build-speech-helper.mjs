/**
 * Compiles the voice-input helper (native/atomic-speech.swift) into
 * out/native/atomic-speech. It takes about two seconds, so it runs on every
 * `npm run build` rather than in a separate step nobody remembers.
 *
 * Off macOS, or on a Mac with no swiftc at all, the step is skipped and the
 * build carries on: the binary is absent, and voice:probe then disables the
 * mic button with `Voice input needs the speech helper, which this build was
 * packaged without`. When swiftc IS there and the compile fails, the build
 * fails with the compiler output: a broken helper takes live dictation and
 * file transcription down together, and a quiet "skipped" hid that.
 * ATOMIC_SKIP_SPEECH_HELPER=1 skips it on purpose (an older Xcode). The
 * decision lives in speech-helper-plan.mjs so it can be tested.
 *
 * `-swift-version 5` is deliberate. AVAudioConverter's input block is
 * @Sendable and the mutable `served` flag it captures is a hard error under
 * the Swift 6 language mode; the buffer itself already travels in an
 * explicit @unchecked Sendable box, so this pin is the only thing keeping
 * the compile silent. `-target <arch>-apple-macos26.0` (speechHelperTarget:
 * arm64, or x86_64 on an Intel Mac) matches the SpeechAnalyzer availability
 * floor.
 *
 * ATO-1064: the same step compiles native/atomic-fn-key.swift into
 * out/native/atomic-fn-key, the small watcher that says when Fn is held
 * down and let go (main/dictate-hold.ts). It needs no macOS 26 API, so its
 * target is the app's own floor, macOS 14. Same rules: skipped with the
 * speech helper, and a compile error fails the build.
 *
 * ATO-2499: native/atomic-show-once.swift (Show once's Accessibility
 * helper) is compiled the same way into out/native/atomic-show-once. The
 * list and the targets are smallHelpers in speech-helper-plan.mjs. Without
 * it (ATOMIC_SKIP_SPEECH_HELPER=1, no swiftc) Show once still records,
 * asking osascript once per event.
 *
 * ATO-2514: and native/atomic-system-audio.swift into
 * out/native/atomic-system-audio, the ScreenCaptureKit tap that records
 * the other side of a call for "Record a meeting" (main/meeting-system-audio.ts).
 * macOS 14 target on this Mac's arch (systemAudioTarget); same rules.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFailureMessage, smallHelpers, speechHelperPlan, speechHelperTarget, systemAudioTarget } from "./speech-helper-plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "native", "atomic-speech.swift");
const outDir = join(here, "..", "out", "native");
const out = join(outDir, "atomic-speech");
const systemAudioSrc = join(here, "..", "native", "atomic-system-audio.swift");
const systemAudioOut = join(outDir, "atomic-system-audio");

const plan = speechHelperPlan({
  platform: process.platform,
  env: process.env,
  hasSource: existsSync(src),
  hasSwiftc: () => {
    try {
      execFileSync("xcrun", ["-f", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return true;
    } catch {
      return false;
    }
  },
});

if (plan.action === "skip") {
  console.log(`speech helper: skipped (${plan.reason})`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
try {
  // Through `xcrun`, not the resolved swiftc path: xcrun is what puts SDKROOT
  // in the environment, and a bare swiftc dies with "unable to load standard
  // library for target arm64-apple-macos26.0".
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-swift-version", "5", "-target", speechHelperTarget(), src, "-o", out],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  console.log(`speech helper → ${out}`);
} catch (err) {
  // swiftc wrote its diagnostics straight to stderr (stdio inherit) above.
  console.error(compileFailureMessage(err));
  process.exit(1);
}

for (const helper of smallHelpers()) {
  const from = join(here, "..", "native", helper.source);
  if (!existsSync(from)) continue;
  try {
    execFileSync(
      "xcrun",
      ["swiftc", "-O", "-swift-version", "5", "-target", helper.target, from, "-o", join(outDir, helper.name)],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    console.log(`${helper.name} → ${join(outDir, helper.name)}`);
  } catch (err) {
    const first = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.error(`${helper.name}: swiftc failed (${first}).\nThe compiler output is above. ${helper.without}`);
    process.exit(1);
  }
}

if (existsSync(systemAudioSrc)) {
  try {
    execFileSync(
      "xcrun",
      ["swiftc", "-O", "-swift-version", "5", "-target", systemAudioTarget(), systemAudioSrc, "-o", systemAudioOut],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    console.log(`system audio helper → ${systemAudioOut}`);
  } catch (err) {
    const first = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.error(`system audio helper: swiftc failed (${first}).\nThe compiler output is above. Without this helper a meeting records only the microphone, not the other side of the call.`);
    process.exit(1);
  }
}
