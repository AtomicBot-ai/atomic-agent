/**
 * GitHub as an Integrations-hub tenant.
 *
 * Two things live here, and only two. The **token** — stored in
 * `<stateDir>/.env` as `GITHUB_TOKEN`, where the `gh` CLI, the skills
 * hub and the release checker already look for it — and the **Remote
 * sync** switch, `git.remoteSync` in `config.json`. The switch is what
 * makes a repository the agent versions a *closed* one: while it is
 * off, every network git verb is refused, through the dedicated git
 * tools and through the shell alike, so the project stays on this
 * machine with its full history and nothing reaches a server until the
 * operator flips it. The token never enters `config.json`, a remote
 * URL, or `.git/config`.
 */

import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";

/** Env var the token is stored under; shared with `gh` and the skills hub. */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
export const GITHUB_INTEGRATION_ID = "github";
export const GITHUB_TEST_ACTION = "test";

const TOKEN_FIELD = "token";

/**
 * Every token GitHub issues today carries a typed prefix: classic
 * (`ghp_`), fine-grained (`github_pat_`), OAuth (`gho_`), user-to-server
 * (`ghu_`), server-to-server (`ghs_`). Checking the prefix at entry
 * catches the common mistakes — a password, an SSH key, a Composio key —
 * before they fail as an opaque 401 at push time.
 */
const TOKEN_SHAPE = /^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;

export const githubIntegration: IntegrationDescriptor = {
  id: GITHUB_INTEGRATION_ID,
  label: "GitHub",
  summary:
    "Sync a repository with GitHub when you choose to — off by default, so a project stays on this machine",
  docsUrl: "https://github.com/settings/personal-access-tokens/new",
  // The token is read from the environment at call time and the
  // switch straight from config, so a saved value is live at once.
  appliesLive: true,
  setupSteps: [
    "github.com → Settings → Developer settings → Personal access tokens → Fine-grained → Generate.",
    "Repository access: only the repositories the agent may sync. Never \"All repositories\".",
    "Permissions → Repository → Contents: Read and write. That is all push and pull need.",
    "Copy the token (github_pat_…) and paste it below (e edits, enter saves). It lives only in .env.",
    "Press t to test it. Leave Remote sync off until a repository should leave this machine.",
  ],
  fields: [
    {
      key: TOKEN_FIELD,
      label: "Token",
      envVar: GITHUB_TOKEN_ENV,
      secret: true,
      required: true,
      help: "Fine-grained personal access token with Contents: read/write on the repos to sync. Stored in .env only.",
      validate: (raw) =>
        TOKEN_SHAPE.test(raw)
          ? undefined
          : "Doesn't look like a GitHub token — expected github_pat_… or ghp_…. Generate one under Developer settings.",
    },
    {
      key: "remoteSync",
      label: "Remote sync",
      kind: "boolean",
      store: "config",
      configPath: "git.remoteSync",
      secret: false,
      required: false,
      help: "off keeps every repository on this machine — no push, fetch, pull or clone. on allows them, each with approval. Enter toggles.",
    },
  ],
  actions: [
    {
      key: "t",
      id: GITHUB_TEST_ACTION,
      label: "test",
      // Nothing to test before a token exists.
      available: (ctx) => ctx.presentFields.has(TOKEN_FIELD),
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    if (!ctx.presentFields.has(TOKEN_FIELD)) {
      return { level: "not_configured", detail: "no token — git stays local" };
    }
    const probe = ctx.probes?.get(GITHUB_INTEGRATION_ID);
    if (probe === undefined) {
      return { level: "configured", detail: "token saved — press t to test" };
    }
    return probe.ok
      ? { level: "connected", detail: `as ${probe.detail}` }
      : { level: "error", detail: probe.detail };
  },
};
