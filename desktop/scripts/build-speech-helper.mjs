/**
 * Compiles the voice-input helper (native/atomic-speech.swift) into
 * out/native/atomic-speech. It takes about two seconds, so it runs on every
 * `npm run build` rather than in a separate step nobody remembers.
 *
 * The build must never fail for someone without Xcode or off macOS: no
 * swiftc means the binary is absent, and voice:probe then disables the mic
 * button with `Voice input needs the speech helper, which this build was
 * packaged without`. Nothing else in the app depends on it.
 *
 * `-swift-version 5` is deliberate. AVAudioConverter's input block is
 * @Sendable and the mutable `served` flag it captures is a hard error under
 * the Swift 6 language mode; the buffer itself already travels in an
 * explicit @unchecked Sendable box, so this pin is the only thing keeping
 * the compile silent. `-target arm64-apple-macos26.0` matches the
 * SpeechAnalyzer availability floor.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "native", "atomic-speech.swift");
const outDir = join(here, "..", "out", "native");
const out = join(outDir, "atomic-speech");

if (process.platform !== "darwin") {
  console.log("speech helper: skipped (not macOS)");
  process.exit(0);
}

try {
  execFileSync("xcrun", ["-f", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch {
  console.log("speech helper: skipped (no swiftc)");
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
  // A compile failure on an older SDK is not a reason to break the app's
  // build; the button disables itself with the honest reason instead.
  console.log(`speech helper: skipped (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
}
