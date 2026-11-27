/**
 * ATO-2459: `atomicagent://app/open?id=<id>`, the link an installed My apps
 * launcher opens (my-apps-install.ts). Unlike the other links it shows no
 * card: it names one of the person's own apps, already on this computer,
 * which opens in its locked-down window (no network, no Node, no chat), the
 * way a Chrome app shortcut opens its window without asking. A link to an id
 * that is not an app opens nothing (the window says it is gone).
 *
 * Imported for its registration by main.ts. No Electron import.
 */

import { displayLink, registerDeeplinkRoute, takeParams, type DeeplinkRequest, type DeeplinkRoute } from "./deeplink.js";
import { isAppId } from "./my-apps-store.js";

export const APP_OPEN_ROUTE = "app-open";

export const appOpenRoute: DeeplinkRoute = (link) => {
  if (link.path.join("/") !== "open") return { ok: false, error: "The app link can only open an app (atomicagent://app/open)." };
  const p = takeParams(link, { id: { max: 1, required: true } });
  if (!p.ok) return p;
  const id = p.values.id![0]!.trim();
  if (!isAppId(id)) return { ok: false, error: "The link does not name an app in My apps." };
  return { ok: true, request: { route: APP_OPEN_ROUTE, link: displayLink(link.raw), id } };
};

registerDeeplinkRoute("app", appOpenRoute);

/** The app id an app-open request names, or null for any other request. */
export function appOpenRequestId(req: DeeplinkRequest | null | undefined): string | null {
  return req && req.route === APP_OPEN_ROUTE && isAppId(req.id) ? req.id : null;
}
