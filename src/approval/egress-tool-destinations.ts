import { hostOfGitUrl, normaliseHost } from "./egress-host.js";
import type { EgressDestination } from "./egress-scan.js";

/**
 * Where the two tools that send data without a shell send it (ATO-2528),
 * in the shape `egress-scan.ts` gives shell commands, so the card says
 * `sends data to → github.com` and the egress hold applies to them too.
 * Before, only `os.shell.run` filled `ApprovalRequest.egress`: the same
 * push through `os.git.push` went out unheld.
 */

/**
 * `os.git.push`: the push URLs of `remote`, one entry per host. `git push
 * <remote>` sends to every `pushurl` (or every `url` when there is no
 * pushurl), so each one is on the card and in the hold (review round 1).
 * A path on this machine sends nothing out; an unreadable URL is an
 * unknown host.
 */
export function gitPushEgress(remoteUrls: string | readonly string[], remote: string): EgressDestination[] {
  const urls = typeof remoteUrls === "string" ? [remoteUrls] : remoteUrls.length > 0 ? remoteUrls : [""];
  const found: EgressDestination[] = [];
  for (const url of urls) {
    const host = hostOfGitUrl(url);
    if (host === "local") continue;
    if (found.some((entry) => entry.host === host)) continue;
    found.push({ kind: "git_remote", host, direction: "outbound", label: host ?? `git remote "${remote}"` });
  }
  return found;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `os.http.request`: a read only fetches; any other method sends its body. */
export function httpRequestEgress(url: URL, method: string): EgressDestination[] {
  const host = normaliseHost(url.hostname);
  return [
    {
      kind: "url",
      host,
      direction: READ_METHODS.has(method.toUpperCase()) ? "inbound" : "outbound",
      label: host ?? "an address that cannot be read",
    },
  ];
}
