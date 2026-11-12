import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `traffic-analytics` starter (ATO-976) answers "why did traffic
 * drop" from the user's own GA4, Search Console and PostHog. These cases
 * pin the no-invented-numbers rule, the four report recipes and the
 * script that keeps credentials out of the chat.
 */
describe("the traffic-analytics starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const root = join(dir, "traffic-analytics");
  const body = readFileSync(join(root, "SKILL.md"), "utf8");
  const scriptPath = join(root, "scripts", "analytics-query.mjs");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("traffic-analytics");
    const { manifest } = parseSkillFile(body);
    expect(manifest.name).toBe("traffic-analytics");
    expect(manifest.requiresScripts).toEqual(["analytics-query.mjs"]);
  });

  it("is selected for a traffic drop question", () => {
    expect(body).toMatch(/description:.*traffic drop/);
    expect(body).toMatch(/description:.*Never invents numbers/);
  });

  it("forbids invented numbers and says what to connect instead", () => {
    expect(body).toMatch(/## The rule: no invented numbers/);
    expect(body).toMatch(/must come from a query result/);
    expect(body).toMatch(/say exactly what is needed to connect it/);
    expect(body).toMatch(/\*\*hypothesis\*\*/);
  });

  it("keeps keys out of the chat", () => {
    expect(body).toMatch(/Do not ask them\s+to paste keys into the chat/);
  });

  it("has the four report recipes", () => {
    expect(body).toMatch(/## Recipe 1: why did traffic drop/);
    expect(body).toMatch(/## Recipe 2: fast-rising queries/);
    expect(body).toMatch(/## Recipe 3: keyword cannibalization/);
    expect(body).toMatch(/## Recipe 4: PostHog funnel/);
    expect(body).toMatch(/several of the user's own pages rank for the same\s+query/);
  });

  it("uses the official endpoints", async () => {
    const mod = await import(pathToFileURL(scriptPath).href);
    expect(mod.ga4Url("123")).toBe(
      "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport",
    );
    expect(mod.ga4Url("properties/123")).toBe(mod.ga4Url("123"));
    expect(mod.gscUrl("sc-domain:example.com")).toBe(
      "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
    );
    expect(mod.posthogUrl("https://eu.posthog.com/", 42)).toBe(
      "https://eu.posthog.com/api/projects/42/query/",
    );
    expect(mod.posthogUrl(undefined, 42)).toBe(
      "https://us.posthog.com/api/projects/42/query/",
    );
  });

  it("names what is missing without leaking set values", async () => {
    const mod = await import(pathToFileURL(scriptPath).href);
    expect(mod.missingSetup(mod.TEMPLATE, "ga4")).toHaveLength(2);
    expect(mod.missingSetup(mod.TEMPLATE, "posthog")).toHaveLength(2);
    const ready = {
      google: { accessToken: "ya29.secret-value" },
      ga4PropertyId: "1",
      gscSiteUrl: "https://example.com/",
      posthog: { projectId: "1", personalApiKey: "phx_secret" },
    };
    for (const source of ["ga4", "gsc", "posthog"]) {
      expect(mod.missingSetup(ready, source)).toEqual([]);
    }
    const partial = { posthog: { personalApiKey: "phx_secret" } };
    const missing = mod.missingSetup(partial, "posthog").join(" ");
    expect(missing).toMatch(/projectId/);
    expect(missing).not.toMatch(/phx_secret/);
  });

  it("reads the credentials file from the state dir", async () => {
    const mod = await import(pathToFileURL(scriptPath).href);
    expect(mod.configPath({ ATOMIC_AGENT_STATE_DIR: "/s" })).toBe(
      join("/s", "traffic-analytics.json"),
    );
    expect(
      mod.configPath({ ATOMIC_AGENT_ANALYTICS_CONFIG: "/x/a.json", ATOMIC_AGENT_STATE_DIR: "/s" }),
    ).toBe("/x/a.json");
  });

  it("signs a service-account JWT Google can verify", async () => {
    const mod = await import(pathToFileURL(scriptPath).href);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = {
      client_email: "reader@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    const jwt: string = mod.signServiceAccountJwt(sa, mod.GA4_SCOPE, 1_000);
    const [header, claims, signature] = jwt.split(".");
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_000,
      exp: 4_600,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});
