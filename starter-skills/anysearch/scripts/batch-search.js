#!/usr/bin/env node
/**
 * Parallel AnySearch batch search (1–5 queries).
 * Usage:
 *   node batch-search.js '[{"query":"q1","max_results":3},{"query":"q2"}]'
 *   node batch-search.js --queries '[{"query":"q1"},{"query":"q2","tag":"code.doc","params":{"library":"golang"}}]'
 *
 * Optional env: ANYSEARCH_API_KEY. Anonymous access works without a key.
 */
"use strict";

const https = require("https");
const http = require("http");

const API_BASE = (
  process.env.ANYSEARCH_API_BASE_URL || "https://api.anysearch.com"
).replace(/\/$/, "");
const API_KEY = (process.env.ANYSEARCH_API_KEY || "").trim();
const CLIENT = "atomic-agent/skill-batch";

function usage() {
  process.stderr.write(
    "usage: node batch-search.js [--queries] '<json-array-of-query-objects>'\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let raw = "";
  while (args.length) {
    const a = args.shift();
    if (a === "--queries" || a === "-q") raw = args.shift() || "";
    else if (!a.startsWith("-") && !raw) raw = a;
    else usage();
  }
  if (!raw) usage();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("error: queries must be valid JSON\n");
    process.exit(2);
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 5) {
    process.stderr.write("error: queries must be an array of 1–5 objects\n");
    process.exit(2);
  }
  return parsed;
}

function normalize(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("each query item must be an object");
  }
  if (typeof item.query !== "string" || !item.query.trim()) {
    throw new Error("query is required");
  }
  const body = { query: item.query.trim() };
  const tag = item.tag || item.sub_domain;
  if (tag) body.tag = String(tag);
  if (item.params && typeof item.params === "object") body.params = item.params;
  if (item.zone) body.zone = String(item.zone);
  if (item.language) body.language = String(item.language);
  if (item.max_results != null) {
    body.max_results = Math.max(1, Math.min(Number(item.max_results) || 5, 10));
  }
  return body;
}

function restPost(path, payload) {
  const url = new URL(API_BASE + path);
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-Anysearch-Client": CLIENT,
  };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const transport = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            reject(new Error(`invalid JSON (HTTP ${res.statusCode})`));
            return;
          }
          if (
            res.statusCode >= 400 ||
            (json.code !== undefined && json.code !== 0)
          ) {
            reject(
              new Error(
                `${json.message || `HTTP ${res.statusCode}`}${
                  json.request_id ? ` (request_id: ${json.request_id})` : ""
                }`,
              ),
            );
            return;
          }
          resolve(json);
        });
      },
    );
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", (e) => reject(e));
    req.write(body);
    req.end();
  });
}

function format(envelope) {
  const data = envelope.data || {};
  const results = data.results || [];
  const meta = data.metadata || {};
  if (!results.length) return "No relevant results found.";
  const lines = [
    `## Search Results (${meta.total_results ?? results.length} results, ${meta.search_time_ms ?? 0}ms)`,
    "",
  ];
  results.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.title || "(Untitled)"}`);
    if (r.url) lines.push(`- **URL**: ${r.url}`);
    const desc = r.content || r.snippet;
    if (desc) lines.push(`- ${desc}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

async function main() {
  const items = parseArgs(process.argv).map(normalize);
  const settled = await Promise.all(
    items.map(async (body) => {
      try {
        return { body, response: await restPost("/v1/search", body), error: null };
      } catch (error) {
        return { body, response: null, error };
      }
    }),
  );
  const out = [];
  settled.forEach(({ body, response, error }, i) => {
    out.push(`## Query ${i + 1}: ${body.query}`, "");
    if (error) out.push(`Search failed: ${error.message}`);
    else out.push(format(response));
    if (i < settled.length - 1) out.push("", "---", "");
  });
  process.stdout.write(out.join("\n") + "\n");
}

main().catch((e) => {
  process.stderr.write(String(e.message || e) + "\n");
  process.exit(1);
});
