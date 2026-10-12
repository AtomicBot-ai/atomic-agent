/**
 * The Atomic Chat Core release the installer carries.
 *
 * One place for the version: scripts/fetch-core.mjs reads it from this file
 * (a plain text match on the line below, so keep it a string literal) to pick
 * the GitHub release asset at build time, and main/core-seed.ts uses it to
 * place the bundled binary where the agent looks for that version
 * (`<dataDir>/core/versions/<version>/`, src/local-llm/core/core-state.ts).
 *
 * It has to be a version the agent supports (CORE_VERSIONS in
 * src/local-llm/core/core-state.ts). Seeding a version the agent does not
 * list puts a binary nobody reads; bump both together.
 */
export const BUNDLED_CORE_VERSION = "0.13.6";

/** The bundled binary's file name, inside `<resources>/core/`. */
export function bundledCoreFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "atomic-chat-core.exe" : "atomic-chat-core";
}
