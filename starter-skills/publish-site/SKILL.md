---
name: publish-site
description: "Put a static site you built online on the user's own hosting: GitHub Pages by default, or Cloudflare Pages / Netlify. Always asks first, since a published site is public. Use for /publish-site."
version: 1.0.0
requires_tools:
  - os.shell.run
requires_scripts:
  - check-site.sh
dangerous: true
---

# publish-site

Turn a site you made in this chat into a real link. The files go to the
user's own account (GitHub, Cloudflare or Netlify) through that host's
official CLI. Nothing is uploaded anywhere else, and no token passes
through this skill: each CLI uses the sign-in the user already did.

## The one rule

**A published site is public. Never publish without an explicit yes from
the user for this exact publish.** Before every publish (the first one and
every update or rollback) show them, in one message:

- the folder and how many files / how big (from the preflight below);
- where it goes: host, account, repo or project name, and visibility;
- the address it will have, e.g. `https://<user>.github.io/<repo>/`;
- that anyone with the link can open it.

Then wait. "Yes", "publish", "go" count. Silence, "maybe" or a question do
not. The runtime approval prompt still shows on each command; it does not
replace this question. An earlier yes covers only the publish it was given
for, not later updates.

## When to use

- "Publish this site", "put it online", "give me a link", "deploy it",
  "update the live site", "roll back the site", `/publish-site`.

## When NOT to use

- Sites that need a server, database or logins: this skill only publishes
  static files (HTML, CSS, JS, images). Say so and stop.
- Sharing a page only with yourself or a teammate privately: a public host
  is the wrong tool; suggest sending the files instead.
- Custom domains, paid plans, DNS: explain the host's settings page, do
  not change them.

## Step 1. Find the folder to publish

The folder must have `index.html` at its top.

- Plain HTML you wrote: that folder.
- A framework project (Vite, Astro, Next export, etc.): read
  `package.json`, run its build script (`npm run build`), and publish the
  output folder (`dist/`, `build/`, `out/`, `_site/`), never the project
  root.
- For a GitHub Pages project site the site lives under `/<repo>/`. Set the
  framework's base path before building (Vite `base: "/<repo>/"`, Astro
  `base`, Next `basePath`), or use relative links in plain HTML.

## Step 2. Preflight (read-only)

```
skill.run_script({ skill: "publish-site", script: "check-site.sh", args: ["<folder>"] })
```

It prints the file count and size, then a `RESULT:` line:

- `RESULT: ok` → go on.
- `RESULT: warnings` → tell the user each `WARN:` line in plain words and
  fix what you can (relative links, build output instead of project root).
- `RESULT: blocked` → a file looks like a password, key or token. **Do not
  publish.** Name the files, remove them from the published folder (never
  from the user's project without asking), run the preflight again.
- `RESULT: not-a-site` → no `index.html`; go back to step 1.

If `bash` is missing (plain Windows), do the same checks by hand: list the
folder, confirm `index.html`, and look for `.env`, `*.pem`, `*.key` and
strings like `sk-`, `ghp_`, `AKIA`, `PRIVATE KEY`.

## Step 3. Pick the host

Use the host the user names. If they name none, use **GitHub Pages**: the
`github` skill already covers installing and signing in to `gh`. Offer
Cloudflare Pages or Netlify only when the user asks or already uses them.

Ask for a site name if there is none (lowercase, dashes, e.g.
`trip-planner`). It becomes the repo or project name and part of the link.

## GitHub Pages (default)

Free GitHub Pages needs a **public** repository; say so in the yes/no
question. All commands below run through `os.shell.run`. Run them from a
staging folder in the system temp dir, never inside the user's project.

1. **Who is signed in:** `gh api user --jq .login` → `<owner>`. On a
   "not logged in" error, follow the `github` skill's setup playbook.
2. **Repo:** `gh repo view <owner>/<name> --json name,visibility`.
   - Missing → (after the yes) `gh repo create <name> --public --description "<one line>"`.
   - Exists and private → stop and ask; do not change its visibility.
   - Exists with other content on `main` → fine, the site goes to its own
     `gh-pages` branch and `main` is not touched.
3. **Staging copy:**
   - Branch `gh-pages` exists (`gh api repos/<owner>/<name>/branches/gh-pages`):
     `git clone --branch gh-pages --single-branch https://github.com/<owner>/<name>.git <staging>`.
   - First publish: `git init -b gh-pages <staging>`, then
     `git -C <staging> remote add origin https://github.com/<owner>/<name>.git`.
   - Replace the files: `git -C <staging> rm -rq --ignore-unmatch .`, copy
     the site folder's contents in (without `.git` and `node_modules`), add
     an empty `.nojekyll` file so folders starting with `_` are served.
4. **Commit and push** (no `--force`, ever):
   `git -C <staging> add -A`,
   `git -C <staging> commit -m "Publish <YYYY-MM-DD HH:MM>"`,
   `git -C <staging> push origin gh-pages`.
   - Auth error on push → `gh auth setup-git` (asks approval), push again.
   - `blocked by shell guard: policy.git_remote_sync_off` → Remote sync is
     off on purpose. Tell the user it can be turned on under
     Integrations → GitHub, and stop.
   - "nothing to commit" → the live site already matches; say so.
5. **Turn Pages on** (first publish only):
   `gh api -X POST repos/<owner>/<name>/pages -f "source[branch]=gh-pages" -f "source[path]=/"`.
   A 409 "already enabled" is fine.
6. **Wait for it:** `gh api repos/<owner>/<name>/pages/builds/latest --jq .status`
   until `built` (check up to 6 times, about 20 seconds apart). `errored`
   → show the error, stop. Then get the link:
   `gh api repos/<owner>/<name>/pages --jq .html_url`.
7. **Report** the link, and that the first publish can take a minute or two
   to appear (a 404 right away is normal).

A repo named `<owner>.github.io` is served at `https://<owner>.github.io/`
(no sub-path). Use it only when the user asks for their main site.

### Versions and rollback (GitHub)

Every publish is one commit on `gh-pages`, so the history is the version
list.

- **List versions:** `gh api "repos/<owner>/<name>/commits?sha=gh-pages&per_page=10" --jq '.[] | .sha[0:7] + "  " + .commit.message'`.
- **Roll back the last publish** (after a yes): clone `gh-pages` to staging
  as in step 3, `git -C <staging> revert --no-edit HEAD`, push. To go back
  to an older version: `git -C <staging> revert --no-edit <sha>..HEAD`
  (one commit per undone publish), push. Never reset or force-push: the
  history is how the user gets any version back.
- **Take the site down** (after a yes): `gh api -X DELETE repos/<owner>/<name>/pages`.
  The repo and its history stay. Never delete the repo unless the user
  asks for exactly that.

## Cloudflare Pages

Needs the `wrangler` CLI (`npm install -g wrangler`, asks approval) and a
sign-in the user does in their own terminal: `wrangler login` opens a
browser, so it cannot run from here. Ask them to run it and tell you when
done. Check with `wrangler whoami`.

- First publish (after the yes):
  `wrangler pages project create <name> --production-branch main`.
- Publish or update (after the yes):
  `wrangler pages deploy <folder> --project-name <name> --branch main`.
  The link is `https://<name>.pages.dev`; the command also prints a
  per-version link.
- **Versions:** `wrangler pages deployment list --project-name <name>`.
- **Roll back:** in the Cloudflare dashboard, Workers & Pages → the project
  → Deployments → the older deployment → Rollback. Or deploy the older
  build folder again. Tell the user which one you are doing.

## Netlify

Needs `netlify-cli` (`npm install -g netlify-cli`, asks approval) and
`netlify login`, which the user runs in their own terminal (it opens a
browser). Check with `netlify status`.

- First publish (after the yes): `netlify sites:create --name <name>`.
- Preview first, if the user wants to look before going live:
  `netlify deploy --dir <folder> --site <name>` prints a draft link. Draft
  links are hard to guess but not private; say so.
- Publish or update (after the yes):
  `netlify deploy --dir <folder> --site <name> --prod`. The link is
  `https://<name>.netlify.app`.
- **Versions and rollback:** every deploy is kept. In the Netlify UI:
  Deploys → the older deploy → "Publish deploy". From the CLI:
  `netlify api listSiteDeploys --data '{"site_id":"<site-id>"}'`, then
  `netlify api restoreSiteDeploy --data '{"site_id":"<site-id>","deploy_id":"<deploy-id>"}'`
  (the site id is in `netlify status` or `netlify sites:list`).

## Rules

- No yes, no publish. Updates, rollbacks and take-downs need their own yes.
- Never publish a `RESULT: blocked` folder. Never put tokens in command
  arguments, files or the commit message.
- Never `--force` push, rewrite `gh-pages` history, change repo
  visibility, or delete a repo or project on your own.
- If a host command fails twice for the same reason, stop and show the
  error instead of trying other hosts or workarounds.
- After publishing, give the link and one line on how to update or roll
  back. Do not claim the site works until the link loads (open it with the
  browser tools if available, or say you could not check).
