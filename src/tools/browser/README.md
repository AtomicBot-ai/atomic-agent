# Browser tools

Status: current
Owner: src/tools/browser/

`browser.*` drives a Chromium-family browser through Playwright (`playwright-backend.ts`) behind the `BrowserBackend` interface, so tests run on a fake backend.

## Approval gate

- `browser.navigate` and `browser.tabs` new ask before a non-http(s) URL (`browser_nonweb`, level 5).
- `browser.click` and `browser.type` read the target element first (`describeRef`, `describe-element.ts`) and classify the action (`classify-browser-action.ts`). The check runs after the stale-ref preflight and before the backend acts.
  - `browser_commit` (level 4, grantable for the session): submit controls, clicks named send / post / publish / delete / confirm / sign up and similar (English and Russian), Enter in a form or a non-search text field, and any element that could not be inspected (fail closed).
  - `browser_secret` (level 5, never granted): typing into password, one-time-code or payment card fields, clicks that pay, and commit-like actions on known payment hosts. The preview shows the text length, never the text.
  - Links, tabs, checkboxes, menus, typing without Enter and Enter in a search box do not ask.
- Domain lists from config.json (`browser.blockedDomains`, `browser.allowedDomains`, `browser-domain-policy.ts`): a blocked host (and its subdomains) is refused as a tool error at every approval level for navigate, tabs new, search (the engine host) and click / type on a blocked page. With a non-empty allow-list, opening any other host asks (`browser_offsite`, level 3).

Read [tool instructions](../AGENTS.md) and the adjacent tests before changing the classifier or the gate order.
