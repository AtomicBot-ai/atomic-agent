/**
 * GitHub as an Integrations-hub tenant.
 *
 * One secret field — a personal access token — because that is the
 * whole handshake: GitHub has no device flow for an app that has not
 * registered an OAuth client, and a token the operator mints themselves
 * is scoped exactly as narrowly as they choose. The token is stored as
 * `GITHUB_TOKEN`, the name `gh`, the skill hub and the updater already
 * read, so one paste connects the agent's own tools (`github.*`,
 * `os.git.push`) and any `gh` call it makes through the shell.
 *
 * Two verbs: `verify` asks GitHub who the token belongs to and shows
 * the login and scopes as the live status; `import` copies the token
 * `gh auth login` already stored, for operators who never want to
 * paste one.
 */

import {
  GITHUB_TOKEN_ENV,
  looksLikeGithubToken,
} from "../github/github-token.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";
import { isConfigured } from "./integration-descriptor.js";

export const GITHUB_TOKEN_FIELD = "token";
export const GITHUB_INTEGRATION_ID = "github";

export const githubIntegration: IntegrationDescriptor = {
  id: GITHUB_INTEGRATION_ID,
  label: "GitHub",
  summary:
    "Push commits, open pull requests and file issues from the agent, in your name",
  docsUrl: "https://github.com/settings/personal-access-tokens/new",
  // The token is read at call time by every consumer, and the hub
  // refreshes the tool catalog after a save, so nothing needs a restart.
  appliesLive: true,
  setupSteps: [
    "Open github.com → Settings → Developer settings → Personal access tokens → Fine-grained.",
    "Generate new token; under Repository access pick the repos the agent may touch.",
    "Permissions → Repository: Contents, Pull requests, Issues = Read and write. Metadata = Read.",
    "Copy the token (starts with github_pat_), press e on Token below, paste, press enter.",
    "Already use the gh CLI? Press i instead to import the token gh stored.",
    "Press v to verify — the status line then shows the account the token belongs to.",
  ],
  fields: [
    {
      key: GITHUB_TOKEN_FIELD,
      label: "Token",
      envVar: GITHUB_TOKEN_ENV,
      secret: true,
      required: true,
      help: "Fine-grained PAT (github_pat_…) or classic (ghp_…). Also picked up by gh in the shell.",
      validate: (raw) =>
        looksLikeGithubToken(raw)
          ? undefined
          : "Doesn't look like a GitHub token — expected github_pat_… or ghp_…. Copy the token itself, not its name.",
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
      key: "v",
      id: "verify",
      label: "verify",
      available: (ctx) => ctx.presentFields.has(GITHUB_TOKEN_FIELD),
    },
    {
      key: "i",
      id: "import",
      label: "import from gh",
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    if (!isConfigured(githubIntegration, ctx.presentFields)) {
      return { level: "not_configured", detail: "no token" };
    }
    const error = ctx.verifyErrors?.get(GITHUB_INTEGRATION_ID);
    if (error !== undefined) return { level: "error", detail: error };
    const identity = ctx.verifiedIdentities?.get(GITHUB_INTEGRATION_ID);
    if (identity !== undefined) {
      return { level: "connected", detail: identity };
    }
    return { level: "configured", detail: "token saved — press v to verify" };
  },
};
