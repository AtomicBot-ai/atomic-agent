/**
 * ATO-1136: the artifact scheme and its routes (artifact-frame.ts says why).
 *
 *   app:artifactPut    keep a page, answer its `atomic-art://<token>/` URL
 *   app:artifactDrop   forget a page the window replaced
 *
 * registerArtifactScheme runs before the app is ready (Electron's rule for
 * privileged schemes); wireArtifactIpc after, once.
 */

import { ipcMain, protocol, session } from "electron";

import { ARTIFACT_SCHEME, ArtifactStore } from "./artifact-frame.js";

const store = new ArtifactStore();

/** Before app ready. Standard so the token parses as a host; secure so a page's canvas and crypto work. Nothing else. */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } },
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
