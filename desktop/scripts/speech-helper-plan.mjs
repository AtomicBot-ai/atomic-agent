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

/**
 * ATO-1506: the swiftc target for the Mac this build runs on. Each mac job
 * builds on its own arch (macos-15 arm64, macos-15-intel x64), so the
 * helper is compiled for that arch; macOS 26 is the SpeechAnalyzer floor.
 */
export function speechHelperTarget(arch = process.arch) {
  return `${arch === "x64" ? "x86_64" : "arm64"}-apple-macos26.0`;
}

/**
 * The small helpers compiled right after the speech helper, with the same
 * rules (skipped with it, a compile error fails the build). They need no
 * macOS 26 API, so their floor is the app's own, macOS 14, and like the
 * speech helper each is built for this build's arch: arm64, or x86_64 on
 * the Intel job (ATO-1506). The Fn watcher used to be pinned to arm64,
 * which an Intel Mac cannot run.
 *
 * - atomic-fn-key (ATO-1064): says when Fn is held down and let go.
 * - atomic-show-once (ATO-2499): Show once's Accessibility side.
 *
 * @returns {{ name: string, source: string, target: string, without: string }[]}
 */
export function smallHelpers(arch = process.arch) {
  const cpu = arch === "x64" ? "x86_64" : "arm64";
  return [
    {
      name: "atomic-fn-key",
      source: "atomic-fn-key.swift",
      target: `${cpu}-apple-macos14.0`,
      without: "Without this helper, holding Fn to dictate into any app falls back to the key combination.",
    },
    {
      name: "atomic-show-once",
      source: "atomic-show-once.swift",
      target: `${cpu}-apple-macos14.0`,
      without: "Without this helper, Show once asks osascript once per event and records no menu commands or window titles.",
    },
  ];
}
