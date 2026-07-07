/**
 * Shared handling for a missing `curl` binary. The HTTP/web tools shell out
 * to `curl` on every platform — it is not rewritten to Node `fetch` because
 * `os.web.fetch` relies on `curl --resolve host:port:ip` for DNS-rebinding
 * SSRF protection plus manual redirect walking. On Windows 10 1803+ `curl.exe`
 * ships with the OS; older systems or stripped PATHs may lack it. When the
 * spawn fails with ENOENT we surface a clear, actionable error instead of the
 * raw `spawn curl ENOENT`.
 */
export function isCurlMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT";
}

export class CurlUnavailableError extends Error {
  constructor() {
    super(
      "curl is required for HTTP/web tools but was not found on PATH. On Windows 10 1803+ curl.exe ships with the OS — update Windows, or install curl and ensure it is on PATH.",
    );
    this.name = "CurlUnavailableError";
  }
}
