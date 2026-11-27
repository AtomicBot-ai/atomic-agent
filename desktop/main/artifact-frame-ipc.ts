/**
 * ATO-1136: the artifact scheme and its routes (artifact-frame.ts says why).
 *
 *   app:artifactPut    keep a page, answer its `atomic-art://<token>/` URL
 *   app:artifactDrop   forget a page the window replaced
 *
 * ATO-2536: watchArtifactChildFrames drops an artifact page that made a
 * child frame anyway (artifact-rtc-block.ts, layer 3).
 *
 * registerArtifactScheme runs before the app is ready (Electron's rule for
 * privileged schemes); wireArtifactIpc after, once.
 */

import { ipcMain, protocol, session, type WebContents, type WebFrameMain } from "electron";

import { ARTIFACT_SCHEME, ArtifactStore, artifactFrameAbove } from "./artifact-frame.js";
import { MY_APP_SCHEME } from "./my-apps-store.js";

const store = new ArtifactStore();

/** Before app ready. Standard so the token parses as a host; secure so a page's canvas and crypto work. Nothing else.
 *  ATO-2383: a saved app's scheme (my-apps-ipc.ts) goes in the same call, since a later call would replace this one;
 *  standard also gives each app an origin of its own, which its localStorage needs. */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } },
    { scheme: MY_APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } },
  ]);
}

let wired = false;
export function wireArtifactIpc(): void {
  if (wired) return;
  wired = true;
  const ses = session.defaultSession;
  if (!ses.protocol.isProtocolHandled(ARTIFACT_SCHEME)) {
    ses.protocol.handle(ARTIFACT_SCHEME, (req) => {
      const r = store.response(req.url);
      return new Response(r.body, { status: r.status, headers: r.headers });
    });
  }
  ipcMain.handle("app:artifactPut", (_event, html: unknown) => store.put(html));
  ipcMain.handle("app:artifactDrop", (_event, url: unknown) => { store.drop(url); return { ok: true }; });
}

/**
 * ATO-2536: a child frame under an artifact page means the page got past the
 * in-page block and could reach a fresh realm's RTCPeerConnection. Main
 * forgets the page and reloads its frame: the reload answers "Not found",
 * and unloading the page closes every peer connection it or its child
 * started. After the fact, so a backstop to the in-page block, not the gate.
 */
export function watchArtifactChildFrames(contents: WebContents): void {
  contents.on("frame-created", (_event, details: { frame?: WebFrameMain | null }) => {
    const page = artifactFrameAbove(details?.frame ?? null);
    if (!page) return;
    store.drop(page.url);
    try { page.reload(); } catch { /* the frame is already gone */ }
  });
}
