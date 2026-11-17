/**
 * ATO-1130: what lets the phone panel (`/panel`, ATO-1128) be added to a
 * phone's home screen and open full screen like an app, without an app
 * store: a web app manifest and the app icon. Strings, like
 * `panel-page.ts`, because `atag` ships as one binary with no files
 * beside it. The icon is the Atomic Agent mark from `assets/logo.svg`,
 * drawn full-bleed (the phone rounds the corners itself).
 */

/** The mark on a full square, so it also works as a maskable icon. */
export const PANEL_ICON_SVG = `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#006AFF"/><path d="M35.2357 49.918C35.923 49.918 36.4741 49.359 36.5369 48.6746C37.1268 42.2442 42.2464 37.1246 48.6768 36.5347C49.3612 36.4719 49.9202 35.9208 49.9202 35.2335L49.9202 28.7624C49.9202 28.0751 49.363 27.518 48.6757 27.518L37.7246 27.518C37.0373 27.518 36.4802 26.9608 36.4802 26.2735L36.4802 15.3224C36.4802 14.6351 35.923 14.078 35.2357 14.078L28.7646 14.078C28.0773 14.078 27.5262 14.6369 27.4634 15.3213C26.8736 21.7517 21.754 26.8714 15.3236 27.4612C14.6391 27.524 14.0802 28.0751 14.0802 28.7624L14.0802 35.2335C14.0802 35.9208 14.6373 36.478 15.3246 36.478L26.2757 36.478C26.963 36.478 27.5202 37.0351 27.5202 37.7224L27.5202 48.6735C27.5202 49.3608 28.0773 49.918 28.7646 49.918L35.2357 49.918Z" fill="white"/></svg>`;

/** 180×180 PNG of the same mark: iOS only takes a PNG `apple-touch-icon`. */
export const PANEL_ICON_PNG_BASE64 =
  "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";

export const PANEL_MANIFEST = JSON.stringify(
  {
    name: "Atomic Agent",
    short_name: "Atomic Agent",
    description: "Your agent's chats and approvals, from your phone.",
    id: "/panel",
    start_url: "/panel",
    scope: "/panel",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#006aff",
    icons: [
      { src: "/panel/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
      { src: "/panel/icon-180.png", sizes: "180x180", type: "image/png" },
    ],
  },
  null,
  2,
);
