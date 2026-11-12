#!/usr/bin/env node
// Query the user's own GA4, Search Console and PostHog with the user's own
// credentials. Credentials live in a local file, never in the chat: skill
// scripts do not inherit secret-looking environment variables, and keys
// printed to stdout would end up in the transcript.
//
// Usage:
//   node analytics-query.mjs check
//   node analytics-query.mjs init
//   node analytics-query.mjs ga4 '<runReport JSON body>'
//   node analytics-query.mjs gsc '<searchAnalytics.query JSON body>'
//   node analytics-query.mjs posthog '<HogQL query>'
//
// Exit codes: 0 ok, 1 API or network error, 2 missing setup, 64 bad usage.

import { createSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function configPath(env = process.env) {
  const override = env.ATOMIC_AGENT_ANALYTICS_CONFIG?.trim();
  if (override) return override;
  const stateDir = env.ATOMIC_AGENT_STATE_DIR?.trim() || join(homedir(), ".atomic-agent");
  return join(stateDir, "traffic-analytics.json");
}

export const TEMPLATE = {
  google: {
    serviceAccountFile: "",
    accessToken: "",
  },
  ga4PropertyId: "",
  gscSiteUrl: "",
  posthog: {
    host: "https://us.posthog.com",
    projectId: "",
    personalApiKey: "",
  },
};

export function loadConfig(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** What each source still needs, in plain words. Never includes secret values. */
export function missingSetup(config, source) {
  const missing = [];
  const google = config?.google ?? {};
  const hasGoogleAuth = Boolean(google.serviceAccountFile || google.accessToken);
  if (source === "ga4") {
    if (!hasGoogleAuth) missing.push("google.serviceAccountFile (a service account JSON key with Viewer access to the GA4 property) or google.accessToken");
    if (!config?.ga4PropertyId) missing.push("ga4PropertyId (the numeric property ID from GA4 Admin > Property details)");
  } else if (source === "gsc") {
    if (!hasGoogleAuth) missing.push("google.serviceAccountFile (a service account JSON key added as a user in Search Console) or google.accessToken");
    if (!config?.gscSiteUrl) missing.push("gscSiteUrl (\"sc-domain:example.com\" for a domain property or \"https://example.com/\" for a URL-prefix property)");
  } else if (source === "posthog") {
    const ph = config?.posthog ?? {};
    if (!ph.personalApiKey) missing.push("posthog.personalApiKey (a personal API key with the query:read scope)");
    if (!ph.projectId) missing.push("posthog.projectId (the number in the project URL or Project settings)");
  }
  return missing;
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** A signed RS256 JWT for the Google OAuth service-account flow. */
export function signServiceAccountJwt(serviceAccount, scope, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer
    .sign(serviceAccount.private_key)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${claims}.${signature}`;
}

export function ga4Url(propertyId) {
  const id = String(propertyId).replace(/^properties\//, "");
  return `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(id)}:runReport`;
}

export function gscUrl(siteUrl) {
  return `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

export function posthogUrl(host, projectId) {
  const base = (host || "https://us.posthog.com").replace(/\/+$/, "");
  return `${base}/api/projects/${encodeURIComponent(String(projectId))}/query/`;
}

async function googleAccessToken(config, scope) {
  const google = config.google ?? {};
  if (google.accessToken) return google.accessToken;
  const sa = JSON.parse(readFileSync(google.serviceAccountFile, "utf8"));
  const assertion = signServiceAccountJwt(sa, scope);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token request failed (${res.status}): ${data.error_description ?? data.error ?? "no details"}`);
  }
  return data.access_token;
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 800);
    try {
      const parsed = JSON.parse(text);
      message = parsed.error?.message ?? parsed.detail ?? parsed.error ?? message;
    } catch {
      // keep the raw text
    }
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${typeof message === "string" ? message : JSON.stringify(message)}`);
  }
  return text;
}

function parseBody(raw, what) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`${what} must be a JSON object`);
  }
}

class UsageError extends Error {}

async function run(argv) {
  const [source, raw] = argv;
  const path = configPath();

  if (source === "init") {
    if (existsSync(path)) {
      process.stdout.write(`exists: ${path}\n`);
      return 0;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(TEMPLATE, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    process.stdout.write(`created: ${path}\nThe user fills in the values in this file themselves. Do not ask them to paste keys into the chat.\n`);
    return 0;
  }

  const config = loadConfig(path);

  if (source === "check") {
    if (config === null) {
      process.stdout.write(`status: no_config\nconfig: ${path}\n`);
      return 2;
    }
    for (const s of ["ga4", "gsc", "posthog"]) {
      const missing = missingSetup(config, s);
      process.stdout.write(missing.length === 0 ? `${s}: ready\n` : `${s}: missing ${missing.join("; ")}\n`);
    }
    return 0;
  }

  if (!["ga4", "gsc", "posthog"].includes(source) || raw === undefined) {
    throw new UsageError("usage: analytics-query.mjs check | init | ga4 '<json>' | gsc '<json>' | posthog '<hogql>'");
  }
  if (config === null) {
    process.stdout.write(`status: no_config\nconfig: ${path}\nRun "init" to create it.\n`);
    return 2;
  }
  const missing = missingSetup(config, source);
  if (missing.length > 0) {
    process.stdout.write(`status: missing_setup\nsource: ${source}\nconfig: ${path}\nmissing: ${missing.join("; ")}\n`);
    return 2;
  }

  let out;
  if (source === "ga4") {
    const token = await googleAccessToken(config, GA4_SCOPE);
    out = await postJson(ga4Url(config.ga4PropertyId), token, parseBody(raw, "the GA4 request"));
  } else if (source === "gsc") {
    const token = await googleAccessToken(config, GSC_SCOPE);
    out = await postJson(gscUrl(config.gscSiteUrl), token, parseBody(raw, "the Search Console request"));
  } else {
    const ph = config.posthog;
    out = await postJson(posthogUrl(ph.host, ph.projectId), ph.personalApiKey, {
      query: { kind: "HogQLQuery", query: raw },
    });
  }
  process.stdout.write(`${out}\n`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(err instanceof UsageError ? 64 : 1);
    },
  );
}
