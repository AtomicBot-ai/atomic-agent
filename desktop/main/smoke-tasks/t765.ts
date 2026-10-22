import { randomUUID } from "node:crypto";

import { BrowserWindow, type WebContents } from "electron";

/**
 * Release-fix checks for ATO-765 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=765`.
 *
 * A window whose page crashed stayed blank or frozen until the person closed
 * it. main.ts reloads it now (render-recovery.ts). Checked: the smoke window's
 * page is crashed on purpose (forcefullyCrashRenderer); it loads again by
 * itself, its own scripts and the sidebar are drawn again, and the agent was
 * not restarted (same state and port before and after).
 *
 * Runs last in the release-fix block: the page it reloads has forgotten
 * whatever an earlier check left open in it.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Status = { state?: string; port?: number | null } | null;

export async function checks765(js: Js, check: Check): Promise<void> {
  const token = `t765-${randomUUID()}`;
  await js<boolean>(`(() => { window.__t765 = ${JSON.stringify(token)}; return true; })()`);
  const before = await js<Status>("window.atomic.status()");

  // The window the smoke drives: the one whose page holds the mark.
  let wc: WebContents | null = null;
  for (const w of BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed())) {
    const mark = await w.webContents.executeJavaScript("window.__t765 || null").catch(() => null);
    if (mark === token) { wc = w.webContents; break; }
  }
  check("T765: the smoke window is found by the mark its page holds", wc !== null);
  if (!wc) return;

  // Held in an object: a `let` set inside the listener stays narrowed to null for the compiler.
  const seen: { gone: string | null } = { gone: null };
  const reloaded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    wc!.once("render-process-gone", (_e, d) => { seen.gone = d.reason; });
    wc!.once("did-finish-load", () => { clearTimeout(timer); resolve(true); });
  });
  wc.forcefullyCrashRenderer();
  const loaded = await reloaded;
  check("T765: the crashed page loads again by itself", loaded && seen.gone !== null && seen.gone !== "clean-exit", JSON.stringify({ loaded, gone: seen.gone }));

  // The page's own scripts drew it again: the sidebar hook is back, and the old page's mark is gone.
  let drawn: { hook: boolean; mark: unknown; rows: number } | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    drawn = await js<{ hook: boolean; mark: unknown; rows: number }>(
      "({hook: typeof window.__sidebar === 'function', mark: window.__t765 ?? null, rows: document.querySelectorAll('#sidebar').length})",
    ).catch(() => null);
    if (drawn?.hook && drawn.rows > 0) break;
    await wait(250);
  }
  check(
    "T765: the reloaded window draws the app again (a fresh page, sidebar present)",
    !!drawn && drawn.hook && drawn.mark === null && drawn.rows > 0,
    JSON.stringify(drawn),
  );

  const after = await js<Status>("window.atomic.status()").catch(() => null);
  check(
    "T765: the agent was not restarted by the window's crash (same state and port)",
    !!before && !!after && after.state === before.state && after.port === before.port,
    JSON.stringify({ before: { state: before?.state, port: before?.port }, after: { state: after?.state, port: after?.port } }),
  );
}
