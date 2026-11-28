import {
  cloudflaredInstallHint,
  findOnPath,
  startCloudflared,
  type CloudflaredHandle,
  type StartCloudflaredOptions,
} from "./cloudflared.js";

/**
 * ATO-2308: `atag pair --remote`, a phone that is not on the same Wi-Fi.
 * Like OpenCode's `pair --remote` (MIT), which prints its REMOTE_WARNING
 * before it opens anything: the warning comes first, then a Cloudflare
 * quick tunnel (no account, a random trycloudflare.com address) in front
 * of serve. cloudflared has to be on PATH; atomic-agent never downloads it.
 *
 * Unlike `atag serve --tunnel` (webhooks only, its own gateway), this
 * tunnel reaches the whole API, because the panel needs chat and
 * approvals. Every route still needs the serve key, a named token or a
 * paired device cookie. The tunnel lives as long as `atag pair` runs.
 */
export const REMOTE_WARNING = [
  "WARNING: --remote puts this agent on the public internet through a Cloudflare quick tunnel.",
  "Anyone who learns the address can reach the sign-in. A paired phone can chat with the agent",
  "and approve the tools it runs, and those act on this computer with your rights.",
  "Pair only your own phone, keep the code private, and press Ctrl+C to close the tunnel when done.",
  "",
].join("\n");

export interface RemoteTunnelDeps {
  findBinary?: (name: string) => string | null;
  start?: (options: StartCloudflaredOptions) => CloudflaredHandle;
  /** Picks the install hint (ATO-2758). */
  platform?: NodeJS.Platform;
}

export type RemoteTunnel =
  | { ok: true; publicUrl: string; stop: () => Promise<void> }
  | { ok: false; error: string };

/** Start the quick tunnel to `originUrl` and wait for its public address. */
export async function openRemoteTunnel(originUrl: string, deps: RemoteTunnelDeps = {}): Promise<RemoteTunnel> {
  const binary = (deps.findBinary ?? ((name: string) => findOnPath(name)))("cloudflared");
  if (!binary) {
    const hint = cloudflaredInstallHint("atag pair --remote", deps.platform);
    return { ok: false, error: `--remote needs cloudflared, and it is not on PATH. ${hint}` };
  }
  const handle = (deps.start ?? startCloudflared)({ binary, request: { mode: "quick" }, originUrl });
  const publicUrl = await handle.publicUrl;
  if (!publicUrl) {
    const tail = handle.recentLog().slice(-5).join("\n");
    await handle.stop().catch(() => {});
    return { ok: false, error: `cloudflared gave no public address${tail ? `:\n${tail}` : ""}` };
  }
  return { ok: true, publicUrl, stop: () => handle.stop() };
}
