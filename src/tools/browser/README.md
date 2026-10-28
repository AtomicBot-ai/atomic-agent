# Browser tools

Status: current
Owner: src/tools/browser/

`browser.*` drives a Chromium-family browser through Playwright (`playwright-backend.ts`) behind the `BrowserBackend` interface, so tests run on a fake backend.

## Approval gate

- `browser.navigate` and `browser.tabs` new ask before a non-http(s) URL (`browser_nonweb`, level 5). A `javascript:` (or `vbscript:`) URL is refused outright: it runs code in the open page, so a `browser_nonweb` answer would otherwise stand in for the click/type gates below.
- `browser.click` and `browser.type` read the target first (`describeRef`, `describe-element.ts`): the nearest enclosing button / link / submit / menu item / tab (an icon inside a button counts as the button), its name (aria-label, aria-labelledby, label, text), form facts and the URL of the frame it is in. `classify-browser-action.ts` then decides. The check runs after the stale-ref preflight and before the backend acts.
  - `browser_commit` (level 4, grantable for the session): submit controls; clicks named send / post / publish / delete / save / confirm / allow / authorize / accept / merge / sign up and similar (English, Russian, basic German, Spanish, French, Portuguese, Italian, Chinese); Enter in a form or a non-search text field; a click on an element that could not be inspected (fail closed).
  - `browser_secret` (level 5, never granted): typing into password, one-time-code or payment card fields, or into an element that could not be inspected; clicks that pay (pay, buy now, checkout, place order, purchase…); any commit-like action on a payment page (a known payment host, or a checkout-like path such as `/checkout` or Amazon's `/gp/buy`). The preview shows the text length, never the text.
  - "Subscribe", "buy", "order", "book" and "donate" alone are `browser_commit`, and `browser_secret` only on a payment page: a YouTube or newsletter subscribe is not a payment.
  - Links, tabs, checkboxes, menus, typing without Enter and Enter in a search box do not ask.
- The session grant for `browser_commit` covers the whole category, like every grantable category; per-site grants are separate work.
- A browser call that was not approved stops the browser calls queued after it in the same batch (`agent/dispatch/batch-scheduler.ts`).
- Classification and previews rely on labels the page supplies, and a page can lie about them. The gate is a safety net, not a guarantee; secrets are never shown in a prompt either way.

## Domain lists

`browser.blockedDomains` and `browser.allowedDomains` in config.json (`browser-domain-policy.ts`). An entry matches its host and every subdomain.

- Blocked hosts are refused as a tool error (`blocked_domain`) at every approval level:
  - navigate, tabs new and search (the engine host), before the browser moves;
  - click / type on a page, or in a frame, on a blocked host, and a link or form (click or Enter) whose target is on one;
  - after navigate, tabs new, click, Enter and search, the page the browser landed on: a blocked landing clears the tab to `about:blank` (best effort for navigations that start after the action returns);
  - `browser.read_aria` and the world snapshot of a blocked page, or of a page that frames one (AI-mode snapshots include iframe content): no page content reaches the model.
- With a non-empty allow-list, navigate, tabs new, search, and a link or form target outside it ask first (`browser_offsite`, level 3).

## Page views

`browser.read_aria` takes `mode` (`aria-view.ts`, `compact-aria.ts`, ATO-956):

- `full`: the whole tree, as before.
- `interactive`: one line per control (interactive roles, plus any other ref'd node Playwright marks clickable) under landmark / heading headers; page text hidden. Refs are Playwright's own, so click / type resolve them exactly as from the full tree. Names that would read the same once clipped are shown longer.
- `diff`: changes by ref since this tab's last snapshot (`+` added, `~` changed with `was:`, `-` gone). Falls back to `interactive` on a new URL or without history.
- `region` with `ref`: the subtree under one ref.

Without `mode`, a local model or a window ≤ 32k tokens gets `interactive`; others get `full`. The same default applies to the world snapshot after navigate / search. The size budget is 4% of the window (2k–24k chars). Compact views read the whole tree before filtering; a name Playwright writes as a quoted YAML key (`- 'button "Pay: $5" [ref=e7]'`) is unquoted first, so such a control is never dropped. A blocked page, or one framing a blocked site (AI-mode snapshots include iframe content), is neither rendered nor remembered for `diff`.

## Your own Chrome

`browser.connect: "user-chrome"` in config.json (opt-in; default `"agent"`, the agent's own profile). The agent then works in the user's signed-in Chrome (`attach-user-chrome.ts`, `user-chrome-endpoint.ts`):

- Attach order: `browser.cdpUrl` (a Chrome the user started with `--remote-debugging-port`, loopback only), else the `DevToolsActivePort` file Chrome 144+ writes while remote debugging is on (Chrome / Beta / Canary / Chromium / Brave / Edge on macOS, Windows, Linux, or `browser.userDataDir`). Otherwise Chrome is opened once on `chrome://inspect/#remote-debugging` and the agent waits up to 60 s for the user to turn it on and allow Chrome's dialog. Chrome 136+ ignores a debugging port on the default profile, so the agent never launches it with one.
- Not reachable: a plain error with those steps; the next browser call retries.
- The agent opens its own tab and only sees, switches to or closes its tabs and their pop-ups. Shutdown disconnects; the user's windows stay.
- Opening or reading a site the agent has not opened this session asks as `browser_secret` (`user-profile-sites.ts`): navigate, tabs new, search, a link or form to a new host, and `read_aria` (every view) on a page that landed elsewhere; the world snapshot of such a page is skipped. One check (`gate-page-read.ts`) covers blocked frames and this. Once per site per session; hosts in `browser.allowedDomains` do not ask. Reading a signed-in site is reading the account, and a URL can carry what was read to another host.
- Every `browser_commit` (submit, send, post, delete, Enter in a form) asks as `browser_secret`: every time, never covered by a session grant. Non-web URLs (chrome://, file://, view-source:, data:…) are refused outright.
- Cookies, saved passwords and storage are never read. Values of password, one-time-code and card fields are masked in every snapshot, in both modes (`redact-secret-fields.ts`).

Read [tool instructions](../AGENTS.md) and the adjacent tests before changing the classifier or the gate order.
