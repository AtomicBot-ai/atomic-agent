/**
 * ATO-2512: "Sign in with ChatGPT" while the app drives an agent on another
 * computer (remote-agent.ts, ATO-1127).
 *
 * The sign-in, its status and Sign out all run the BUNDLED agent on this
 * computer (`atag login chatgpt`, `login status`, `logout chatgpt`), so in
 * remote mode they signed in, read or signed out the wrong agent: the tokens
 * landed in this computer's state folder while the remote agent kept asking
 * to sign in. The remote agent is reached only over its HTTP API, which has
 * no sign-in route, so the app cannot run `atag login chatgpt --device` there
 * either. The routes answer "remote" instead, and the window says to run the
 * sign-in on that computer (renderer/chatgpt-oauth-step.js,
 * renderer/subscription-oauth-row.js). Precedent: Codex's
 * `codex login --device-auth` and GitHub CLI's `gh auth login` are run on the
 * machine that will use the sign-in.
 *
 * Electron-free so it is under unit test (desktop/test/chatgpt-oauth-remote.test.mjs).
 */

/** chatgptOauth:status on a remote agent: this computer's sign-in says nothing about that one. */
export function remoteStatus(): { ok: true; signedIn: false; plan: null; supported: true; remote: true } {
  return { ok: true, signedIn: false, plan: null, supported: true, remote: true };
}

/** chatgptOauth:start and chatgptOauth:signOut on a remote agent: refused, nothing run. */
export function remoteRefusal(): { ok: false; state: "failed"; reason: "remote" } {
  return { ok: false, state: "failed", reason: "remote" };
}

/** `remote()` when the app drives an agent on another computer, else `local()`. */
export function unlessRemote<L, R>(isRemote: (() => boolean) | undefined, remote: () => R, local: () => L): L | R {
  return isRemote?.() === true ? remote() : local();
}
