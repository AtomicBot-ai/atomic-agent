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
 * the compile silent. `-target arm64-apple-macos26.0` matches the
 * SpeechAnalyzer availability floor.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFailureMessage, speechHelperPlan } from "./speech-helper-plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "native", "atomic-speech.swift");
const outDir = join(here, "..", "out", "native");
const out = join(outDir, "atomic-speech");

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
    ["swiftc", "-O", "-swift-version", "5", "-target", "arm64-apple-macos26.0", src, "-o", out],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  console.log(`speech helper → ${out}`);
} catch (err) {
  // swiftc wrote its diagnostics straight to stderr (stdio inherit) above.
  console.error(compileFailureMessage(err));
  process.exit(1);
}
