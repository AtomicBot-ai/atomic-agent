import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
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

  describe("running the script", () => {
    /** A PostHog stand-in that answers every query with `body`. */
    async function stubServer(body: string): Promise<{ server: Server; url: string }> {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(body);
        });
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      return { server, url: `http://127.0.0.1:${address.port}` };
    }

    function runScript(args: string[], env: Record<string, string>) {
      return new Promise<{ code: number | null; stdout: string }>((ok, fail) => {
        const child = spawn(process.execPath, [scriptPath, ...args], {
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (d: string) => (stdout += d));
        child.on("error", fail);
        child.on("close", (code) => ok({ code, stdout }));
      });
    }

    function setup(host: string, mode = 0o600) {
      const dir = mkdtempSync(join(tmpdir(), "traffic-analytics-"));
      const config = join(dir, "traffic-analytics.json");
      writeFileSync(
        config,
        JSON.stringify({ posthog: { host, projectId: "1", personalApiKey: "phx_test" } }),
        { mode },
      );
      return { dir, config, env: { ATOMIC_AGENT_STATE_DIR: dir, ATOMIC_AGENT_ANALYTICS_CONFIG: config } };
    }

    const bigBody = JSON.stringify({
      columns: ["event", "n", "pad"],
      results: Array.from({ length: 4000 }, (_, i) => [`event_${i}`, i, "x".repeat(30)]),
    });

    it("prints a 200 KB response whole through a pipe with --raw", async () => {
      expect(bigBody.length).toBeGreaterThan(200_000);
      const { server, url } = await stubServer(bigBody);
      const { dir, env } = setup(url);
      try {
        const { code, stdout } = await runScript(["posthog", "SELECT 1", "--raw"], env);
        expect(code).toBe(0);
        expect(stdout.length).toBe(bigBody.length + 1);
        expect(JSON.parse(stdout).results).toHaveLength(4000);
      } finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it("saves a large response privately and prints only a summary and the path", async () => {
      const { server, url } = await stubServer(bigBody);
      const { dir, env } = setup(url);
      try {
        const { code, stdout } = await runScript(["posthog", "SELECT 1"], env);
        expect(code).toBe(0);
        expect(stdout.length).toBeLessThan(8_000);
        expect(stdout).toMatch(/rows: 4000/);
        const saved = stdout.match(/^saved: (.+)$/m)?.[1];
        expect(saved).toBeDefined();
        expect(saved!.startsWith(join(dir, "traffic-analytics", "results"))).toBe(true);
        expect(readFileSync(saved!, "utf8")).toBe(bigBody);
        if (process.platform !== "win32") {
          expect(statSync(saved!).mode & 0o777).toBe(0o600);
        }
      } finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it.skipIf(process.platform === "win32")(
      "keeps the credentials file at mode 600: init creates and tightens it, check warns",
      async () => {
        const { dir, config, env } = setup("http://127.0.0.1:9", 0o644);
        try {
          const warned = await runScript(["check"], env);
          expect(warned.stdout).toMatch(/can be read by other users/);
          const fixed = await runScript(["init"], env);
          expect(fixed.stdout).toMatch(/permissions tightened to 600/);
          expect(statSync(config).mode & 0o777).toBe(0o600);
          const clean = await runScript(["check"], env);
          expect(clean.stdout).not.toMatch(/can be read by other users/);

          const fresh = join(dir, "fresh.json");
          await runScript(["init"], { ...env, ATOMIC_AGENT_ANALYTICS_CONFIG: fresh });
          expect(statSync(fresh).mode & 0o777).toBe(0o600);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      30_000,
    );

    it("never ends with process.exit, which cuts piped output short", () => {
      const source = readFileSync(scriptPath, "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect(source).not.toMatch(/process\.exit\(/);
      expect(source).toMatch(/process\.exitCode = /);
    });
  });

  describe("aggregation on saved results", () => {
    const summaryPath = join(root, "scripts", "analytics-summary.mjs");

    it("flags queries split between several pages", async () => {
      const mod = await import(pathToFileURL(summaryPath).href);
      const out: string = mod.cannibalization({
        rows: [
          { keys: ["local ai agent", "/a"], clicks: 10, impressions: 300, position: 4.2 },
          { keys: ["local ai agent", "/b"], clicks: 5, impressions: 200, position: 5.1 },
          { keys: ["local ai agent", "/c"], clicks: 0, impressions: 10, position: 30 },
          { keys: ["mac agent", "/a"], clicks: 3, impressions: 150, position: 3 },
          { keys: ["tiny", "/a"], clicks: 0, impressions: 20, position: 9 },
          { keys: ["tiny", "/b"], clicks: 0, impressions: 20, position: 9 },
        ],
      });
      expect(out).toMatch(/queries checked: 3; flagged: 1/);
      expect(out).toMatch(/local ai agent \(510 impressions\)/);
      expect(out).toMatch(/\/a: impressions=300/);
      expect(out).toMatch(/\/b: impressions=200/);
      expect(out).not.toMatch(/\/c:/);
      expect(out).not.toMatch(/mac agent|tiny/);
      expect(() => mod.cannibalization({ rows: [{ keys: ["only-query"] }] })).toThrow(/query","page/);
    });

    it("compares two saved results by row", async () => {
      const mod = await import(pathToFileURL(summaryPath).href);
      const cur = { rows: [{ keys: ["q1"], clicks: 5, impressions: 500 }, { keys: ["q3"], clicks: 1, impressions: 80 }] };
      const prev = { rows: [{ keys: ["q1"], clicks: 3, impressions: 100 }, { keys: ["q2"], clicks: 9, impressions: 400 }] };
      const growth: string = mod.compare("gsc", cur, prev, { order: "growth" });
      expect(growth.split("\n").slice(3)).toEqual([
        "q1: 100 -> 500 (+400)",
        "q3: 0 -> 80 (+80) [new]",
        "q2: 400 -> 0 (-400) [gone]",
      ]);
      expect(growth).toMatch(/total: previous=500 current=580 change=80/);
      const ga4 = (value: string) => ({
        dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }],
        metricHeaders: [{ name: "sessions" }],
        rows: [{ dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value }] }],
      });
      expect(mod.compare("ga4", ga4("120"), ga4("200"))).toMatch(/Organic Search: 200 -> 120 \(-80\)/);
    });

    it("caps the summary at 30 rows", async () => {
      const mod = await import(pathToFileURL(summaryPath).href);
      const rows = Array.from({ length: 5000 }, (_, i) => ({ keys: [`q${i}`], clicks: i, impressions: i * 10 }));
      const out: string = mod.summarize("gsc", { rows });
      expect(out.split("\n")).toHaveLength(32);
      expect(out).toMatch(/^rows: 5000/);
      expect(out).toMatch(/q4999: clicks=4999/);
    });
  });
});
