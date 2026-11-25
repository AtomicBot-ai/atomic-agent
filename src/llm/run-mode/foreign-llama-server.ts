/**
 * A `llama-server` entry on a server other than the main local one
 * (`localModels.url`): somebody else's llama.cpp, which serves the model
 * it loaded, not the managed model (ATO-1562).
 */
export function isForeignLlamaServer(
  entry: { kind: string; url?: string },
  mainUrl: string,
): boolean {
  if (entry.kind !== "llama-server" || entry.url === undefined) return false;
  const norm = (u: string): string => u.trim().replace(/\/+$/, "");
  return norm(entry.url) !== norm(mainUrl);
}
