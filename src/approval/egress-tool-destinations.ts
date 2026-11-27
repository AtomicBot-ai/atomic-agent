import { hostOfGitUrl, normaliseHost } from "./egress-host.js";
import type { EgressDestination } from "./egress-scan.js";

/**
 * Where the two tools that send data without a shell send it (ATO-2528),
 * in the shape `egress-scan.ts` gives shell commands, so the card says
 * `sends data to -> github.com` and the egress hold applies to them too.
 * Before, only `os.shell.run` filled `ApprovalRequest.egress`: the same
 * push through `os.git.push` went out unheld.
 */

/** `os.git.push`: the push URL of `remote`. A path on this machine sends nothing out. */
export function gitPushEgress(remoteUrl: string, remote: string): EgressDestination[] {
  const host = hostOfGitUrl(remoteUrl);
  if (host === "local") return [];
  return [{ kind: "git_remote", host, direction: "outbound", label: host ?? `git remote "${remote}"` }];
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
