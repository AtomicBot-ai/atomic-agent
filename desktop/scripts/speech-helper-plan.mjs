/**
 * Whether build-speech-helper.mjs compiles the voice helper, skips it, or
 * fails the build. Pure so desktop/test can check every branch on any OS.
 *
 * - off macOS, no Swift source, or no swiftc: skip (Windows/Linux CI and a
 *   Mac without Xcode or the Command Line Tools still get an app).
 * - ATOMIC_SKIP_SPEECH_HELPER=1: skip on purpose, for a Mac whose swiftc is
 *   too old for the macOS 26 SDK.
 * - otherwise compile, and a compiler error fails the build: one broken
 *   helper disables live dictation and file transcription together, so it
 *   must not slip through as "skipped".
 *
 * @param {{ platform: string, env: Record<string, string | undefined>, hasSource: boolean, hasSwiftc: () => boolean }} input
 * @returns {{ action: "skip", reason: string } | { action: "build" }}
 */
export function speechHelperPlan({ platform, env, hasSource, hasSwiftc }) {
  if (platform !== "darwin") return { action: "skip", reason: "not macOS" };
  const optOut = String(env.ATOMIC_SKIP_SPEECH_HELPER ?? "").trim().toLowerCase();
  if (optOut === "1" || optOut === "true" || optOut === "yes") {
    return { action: "skip", reason: "ATOMIC_SKIP_SPEECH_HELPER is set" };
  }
  if (!hasSource) return { action: "skip", reason: "no Swift source" };
  if (!hasSwiftc()) return { action: "skip", reason: "no swiftc" };
  return { action: "build" };
}

/** The message printed before exiting non-zero on a compile failure. */
export function compileFailureMessage(err) {
  const first = err instanceof Error ? err.message.split("\n")[0] : String(err);
  return [
    `speech helper: swiftc failed (${first}).`,
    "The compiler output is above. Without this helper the app has no voice input and no file transcription.",
    "On a Mac without the macOS 26 SDK, build with ATOMIC_SKIP_SPEECH_HELPER=1 to leave it out on purpose.",
  ].join("\n");
}
