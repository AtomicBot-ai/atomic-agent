/**
 * Whether a base URL points at the operator's own machine. Local servers
 * have no API key and no account behind them, so every check that exists
 * to protect a cloud account has to step aside for them.
 */
export function isLocalProviderUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}
