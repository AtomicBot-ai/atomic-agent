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
- The session grant ("allow in this chat", `[s]`) for `browser_commit` and `browser_offsite` covers one site: the host the request names (`src/approval/site-grants.ts`, ATO-1181). A grant on `example.com` does not cover `mail.example.com` or any other host; a request that names no host is not offered the grant. "Always allow" is not offered for these two categories, since a saved rule has no site field.
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

## Page text is outside data

The page in `### world` and the summaries of `browser.navigate`, `browser.read_aria` and `browser.tabs` (page titles) are framed as external content in a nonce-fenced block, like a fetched page (ATO-1378, `../untrusted-text.ts`). The framing lowers the odds that a page steers the model; the approval gates above are what stop an action.

## Screenshots

`browser.screenshot { ref?, fullPage? }` (`screenshot.ts`, `screenshot-geometry.ts`, ATO-515): a JPEG of the viewport, the whole page (cut at 8000 CSS px) or one element. Long side at most 1280 px, never upscaled; at most 900 KB, retaken smaller (quality 70 → 50 → 40) and refused if still over. Taken through CDP `Page.captureScreenshot` with a scaled clip, with card-number / one-time-code field values drawn as dots for the capture.

Saved under `<tmp>/atomic-agent-browser-shots/<session>/` (outside the working folder, inside the read roots). The model looks at it with `vision.describe`; the desktop and chat channels show it through `reply.attachments`. Read-only, no prompt in the agent's own profile: it shows only what `read_aria` already reads. It goes through the same page-read check as `read_aria` (`gate-page-read.ts`), so in the user's own Chrome a site not opened this session asks first.

A page on a blocked host is never captured. A capture is discarded, never saved, when the page or any of its frames is on a blocked host by the time the pixels are taken (a racing redirect, a blocked iframe).

## More page actions

`browser.act { action, … }` (`act.ts`, `page-action-args.ts`, `playwright-page-actions.ts`, ATO-957) holds the actions click / type do not cover, in one tool so the tool list and a local model's grammar stay small:

- `select` (`ref`, `values`: option values or labels), `upload` (`ref`, `paths`: a file input, or a button that opens a file chooser), `back`, `forward`, `key` (`key` in Playwright's syntax from a closed set, e.g. `Enter`, `Escape`, `Shift+Tab`, `Control+a`; optional `ref`), `hover` (`ref`), `dialog` (`accept`, optional `text` for a prompt), `wait` (`text` to appear, or with `state: "hidden"` to go; a `ref`; or `ms`, at most 10 s; `timeoutMs` at most 30 s).
- `dialog` answers the next alert / confirm / prompt on the active tab within 60 s, so it is called before the click that opens one. Without it Playwright dismisses every dialog, as before.
- Gates, before the backend acts: any action on a blocked host is refused. `upload` asks as `browser_secret` every time, with each file's name, size and full path in the preview; its paths are also checked like reads (`../read-scope/read-scope-targets.ts`), so the agent's own secret files and files outside the read scope ask first. `key` Enter / Space on a `ref` goes through the click / type gate above (Enter like `type` with Enter, Space like a click); without a `ref` the focused element cannot be read, so Enter / Space ask as `browser_commit`. Accepting a dialog asks as `browser_commit` (it may confirm a delete or a payment); dismissing does not. In the user's own Chrome these `browser_commit` prompts ask as `browser_secret`. select, hover, back, forward, wait and other keys do not ask.
- After select, key, back and forward the landed page is re-checked against the block list, like after a click.


## Extracting data

`browser.extract { schema, instruction? }` (`extract.ts`, `extract-request.ts`, ATO-699): structured data out of the active page in one call ("every plan's name and price") instead of a read / scroll chain. The page's full ARIA snapshot (cut to half of the window, 8k–200k chars; 48k when the window is unknown) and the caller's JSON Schema go to one side model call on the step's provider, outside the main slot:

- a grammar (llama-server) link gets GBNF built from the schema (`../../llm/grammar/json-schema-gbnf.ts`): object keys in declared order, required ones always, no others; arrays, enums, consts, unions; parts it does not shape fall back to any JSON;
- a native-tools link gets one `emit_extracted_data` function whose parameters are the schema (a non-object root rides under `data`).

The answer is validated against the full schema (`validateJsonSchemaValue`); a mismatch is an error that shows what came back. The page goes through the same check as `read_aria` (`gate-page-read.ts`), sits in an untrusted block in the side call's prompt, and the result is framed as page content. The model is bound by bootstrap after the tools are registered (`BrowserExtractModelRef`); without it the tool says to use `read_aria`.


## Site tools (WebMCP)

`browser.site_tools { action: "list" | "call", name?, arguments?, timeoutMs? }` (`site-tools.ts`, ATO-521): tools the open page declares for agents through WebMCP (`document.modelContext.registerTool`, from the W3C Web Machine Learning draft, or the older `navigator.modelContext` with `provideContext` / `registerTool` / `unregisterTool` / `clearContext`). One agent tool covers every site's tools.

- An init script (`site-tools-in-page.ts`) records the tools a page registers, before the page's own scripts run. A browser with its own `modelContext` keeps working (the methods are wrapped and still called); a browser without one gets a small stand-in, so a site written for WebMCP works today. In the agent's own browser it is installed on every page; in your own Chrome only on the agent's tabs. A page opened before the script was installed is asked with the browser's own `getTools` / `executeTool`, then Chrome's testing API (`navigator.modelContextTesting`).
- Main frame only: an iframe (an ad, a widget) cannot offer tools.
- Limits (`site-tools-sanitize.ts`): 32 tools shown (64 read), names `[A-Za-z0-9_.:-]` up to 64 characters, schema JSON up to 8000 characters, description up to 1000, arguments up to 16000 characters of JSON, answer up to 20000 characters, timeout 30 s by default (1–120 s). Tools that break a limit are listed as skipped with the reason.
- `list` is a page read: a blocked page, or one framing a blocked site, is refused; in your own Chrome a site not opened this session asks first (`gate-page-read.ts`).
- `call` re-reads the list, checks the arguments against the declared schema (required keys, top-level types, enums, `additionalProperties: false`), then asks as `browser_site_tool` (level 4 beside `browser_commit`; "allow in this chat" covers that one site, `src/approval/site-grants.ts`; never "always"). In your own Chrome it asks as `browser_secret`, every time. The site's `readOnlyHint` is shown, never trusted: every call asks. An answer is thrown away when the page moved to a blocked site.
- Descriptions, schemas and answers are the site's own text and are framed as outside data, like a page (`untrustedOutput`).

## Page views

`browser.read_aria` takes `mode` (`aria-view.ts`, `compact-aria.ts`, ATO-956):

- `full`: the whole tree, as before.
- `interactive`: one line per control (interactive roles, plus any other ref'd node Playwright marks clickable) under landmark / heading headers; page text hidden. Refs are Playwright's own, so click / type resolve them exactly as from the full tree. Names that would read the same once clipped are shown longer.
- `diff`: changes by ref since this tab's last snapshot (`+` added, `~` changed with `was:`, `-` gone). Falls back to `interactive` on a new URL or without history.
- `region` with `ref`: the subtree under one ref.

Without `mode`, a local model or a window ≤ 32k tokens gets `interactive`; others get `full`. The same default applies to the world snapshot after navigate / search. The size budget is 4% of the window (2k–24k chars). Compact views read the whole tree before filtering; a name Playwright writes as a quoted YAML key (`- 'button "Pay: $5" [ref=e7]'`) is unquoted first, so such a control is never dropped. A blocked page, or one framing a blocked site (AI-mode snapshots include iframe content), is neither rendered nor remembered for `diff`.

## Web identity

One honest, fixed identity for the browser the agent launches and for the curl tools (`os.web.fetch`, `os.http.request`, web search), from `web-identity.ts` (ATO-969): Chrome's reduced User-Agent for this OS with the installed browser's major version (`chrome-version.ts`, else `FALLBACK_CHROME_MAJOR`), and Accept-Language from the system locale. The timezone is never overridden. Headless runs as `--headless=new` and gets that UA (only when the version is known), `--lang` and a 1440x900 window; a headed launch keeps Chrome's own. Fingerprints are never rotated or faked.


## Background runs and throwaway profiles

`browser.headless` in config.json (ATO-959, `browser-run-scope.ts`), default `"auto"`:

- A turn nobody watches (a scheduled task, a Telegram or Discord message, a webhook or a plain HTTP client) starts the agent's own Chrome without a window. The TUI, the desktop app and a terminal `run` start it with a window, as before. The runtime sets who the turn is for around each turn (`runInBrowserScope`); a fusion worker counts as the turn that fanned it out.
- One Chrome serves the whole process. A watched turn that finds the agent's Chrome running headless restarts it with a window and reopens its pages; a background turn that finds a window open uses it. A Chrome the agent did not start (`cdpUrl`, your own Chrome) is never restarted.
- `true` / `false` (or env `ATOMIC_AGENT_BROWSER_HEADLESS`, which wins when set) always / never run headless.

`browser.profile` (default `"agent"`, `temp-profiles.ts`): `"temp"` makes each chat browse in its own throwaway, logged-out profile: a separate browser context in the same Chrome, like an incognito window, with no cookies, storage or logins from the agent's profile and nothing written to disk. Per call, `browser.tabs { action: "new", profile: "temp" }` switches the chat to its throwaway profile and `profile: "agent"` back. A throwaway profile closes with its last tab, when more than four are open (oldest first), or with the browser. Not available in your own Chrome.

## Fusion workers: parallel tabs

`worker-tabs.ts` (ATO-961). The runtime marks a fusion worker's turn (`BrowserRunScope.workerOf`):

- A worker browses only in tabs it opened (and their pop-ups), named by its session: `browser.tabs` lists, switches and closes only those, and its page reads and actions go to its own active tab. It never sees another worker's tabs, and the orchestrator's chat does not see the workers' tabs. Workers running at once each have a tab, so five shops can be read side by side.
- When a worker's turn ends, its tabs close.
- `browser.workerIsolation`: `"tabs"` (default) keeps the workers in the agent's profile, with its logins; `"context"` gives each worker its own throwaway browser context (no cookies or logins shared). In your own Chrome workers always use tabs.
- `browser.maxTabs` (default 8, 1 to 50) caps the tabs the agent has open at once, throwaway profiles and workers included. One more fails with a plain error naming the setting, until a tab closes. Pop-ups a page opens are not refused.

## Your own Chrome

`browser.connect: "user-chrome"` in config.json (opt-in; default `"agent"`, the agent's own profile). The agent then works in the user's signed-in Chrome (`attach-user-chrome.ts`, `user-chrome-endpoint.ts`):

- Attach order: `browser.cdpUrl` (a Chrome the user started with `--remote-debugging-port`, loopback only), else the `DevToolsActivePort` file Chrome 144+ writes while remote debugging is on (Chrome / Beta / Canary / Chromium / Brave / Edge on macOS, Windows, Linux, or `browser.userDataDir`). Otherwise Chrome is opened once on `chrome://inspect/#remote-debugging` and the agent waits up to 60 s for the user to turn it on and allow Chrome's dialog. Chrome 136+ ignores a debugging port on the default profile, so the agent never launches it with one.
- Not reachable: a plain error with those steps; the next browser call retries. A Chrome that was quit or restarted is noticed on the next call, which drops the dead connection and attaches again from a fresh `DevToolsActivePort` read; if remote debugging is off in the new Chrome the call fails at once with the steps (no settings page, no wait). The shell refuses to script browsers, so the model cannot work around this (`../os/shell-command-guard/browser-bypass.ts`).
- The agent opens its own tab and only sees, switches to or closes its tabs and their pop-ups. Shutdown disconnects; the user's windows stay.
- Opening or reading a site the agent has not opened this session asks as `browser_secret` (`user-profile-sites.ts`): navigate, tabs new, search, a link or form to a new host, and `read_aria` (every view) or `screenshot` on a page that landed elsewhere; the world snapshot of such a page is skipped. One check (`gate-page-read.ts`) covers blocked frames and this. Once per site per session; hosts in `browser.allowedDomains` do not ask. Reading a signed-in site is reading the account, and a URL can carry what was read to another host.
- Every `browser_commit` (submit, send, post, delete, Enter in a form) asks as `browser_secret`: every time, never covered by a session grant. Non-web URLs (chrome://, file://, view-source:, data:…) are refused outright.
- Cookies, saved passwords and storage are never read. Values of password, one-time-code and card fields are masked in every snapshot, in both modes (`redact-secret-fields.ts`); a code field is also recognised by its name or label ("Verification code", "Код из SMS"), and typing into one asks as `browser_secret` with only the length in the preview.

Read [tool instructions](../AGENTS.md) and the adjacent tests before changing the classifier or the gate order.
