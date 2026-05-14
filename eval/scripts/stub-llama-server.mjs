#!/usr/bin/env node
// Llama-compatible HTTP stub for the eval harness.
//
// Boots a tiny `/health`, `/props`, `/completion` server that returns
// canned tool-call arrays for the prompts shipped in `eval/cases/`. It
// is NOT a model — it lets the harness exercise the full agent loop
// (parsing, tool dispatch, trace recording, metrics) without a real
// llama-server. Use only for harness smoke-tests; quality numbers from
// this stub are meaningless.
//
// Usage:
//   node eval/scripts/stub-llama-server.mjs [--port 18991]
//   ATOMIC_AGENT_EVAL_LLAMA_URL=http://127.0.0.1:18991 npm run eval

import http from "node:http";

const args = process.argv.slice(2);
const portFlagIndex = args.indexOf("--port");
const PORT = portFlagIndex !== -1 ? Number(args[portFlagIndex + 1]) : 18991;

const json = (res, payload, contentType = "application/json") => {
  res.writeHead(200, { "content-type": contentType });
  res.end(JSON.stringify(payload));
};

const completion = (content) => ({
  content,
  stop: true,
  truncated: false,
  tokens_cached: 0,
  slot_id: 0,
  model: "eval-stub",
  timings: {
    prompt_ms: 1,
    predicted_ms: 1,
    prompt_n: 100,
    predicted_n: Math.max(1, Math.ceil(content.length / 4)),
  },
});

const toolArray = (calls) => JSON.stringify(calls);
const oneCall = (tool, args) => toolArray([{ tool, args }]);

const contains = (haystack, needle) => haystack.includes(needle);

const extractLatestUserMessage = (prompt) => {
  const matches = prompt.match(/user: .+/g) ?? [];
  const last = matches.pop() ?? prompt;
  return last.replace(/^user: /, "");
};

const findMockUrl = (prompt) => {
  const match = prompt.match(/http:\/\/127\.0\.0\.1:\d+/);
  return match ? match[0] : "http://127.0.0.1:1";
};

// Decide the next tool-call array for a given prompt body. Branches
// are matched against the LATEST `user:` line so log lines like
// `prompt: ...` cannot poison the routing.
function pickToolCall(prompt) {
  const user = extractLatestUserMessage(prompt);
  const sawRead = contains(prompt, "tool_result[os.fs.read ok]");
  const sawGrep = contains(prompt, "tool_result[os.fs.grep ok]");
  const sawWrite = contains(prompt, "tool_result[os.fs.write ok]");
  const sawGlob = contains(prompt, "tool_result[os.fs.glob ok]");
  const sawShell = contains(prompt, "tool_result[os.shell.run ok]");
  const sawGit = contains(prompt, "tool_result[os.git.status ok]");
  const sawList = contains(prompt, "tool_result[os.fs.list ok]");
  const sawSkill = contains(prompt, "tool_result[skill.view ok]");
  const sawHttp = contains(prompt, "tool_result[os.http.request ok]");

  if (contains(user, "launch date")) {
    return sawRead
      ? oneCall("reply", { text: "2031-04-12" })
      : oneCall("os.fs.read", { path: "README.md" });
  }
  if (contains(user, "TODO(eval)")) {
    return sawGrep
      ? oneCall("reply", { text: "parser.ts" })
      : oneCall("os.fs.grep", {
          pattern: "TODO\\(eval\\)",
          path: ".",
          outputMode: "content",
        });
  }
  if (contains(user, "CHANGELOG.md")) {
    return sawWrite
      ? oneCall("reply", { text: "done" })
      : oneCall("os.fs.write", {
          path: "CHANGELOG.md",
          content: "- v0.1.0: initial eval entry\n",
          mode: "replace",
        });
  }
  if (contains(user, "total: <N>")) {
    return sawGlob
      ? oneCall("reply", {
          text: "src/alpha.ts\nsrc/beta.ts\nlib/deep/gamma.ts\ntotal: 3",
        })
      : oneCall("os.fs.glob", { pattern: "**/*.ts" });
  }
  if (contains(user, "EVAL-OK-9237")) {
    return sawShell
      ? oneCall("reply", { text: "EVAL-OK-9237" })
      : oneCall("os.shell.run", { cmd: "echo", args: ["EVAL-OK-9237"] });
  }
  if (contains(user, "git status")) {
    return sawGit
      ? oneCall("reply", { text: "clean" })
      : oneCall("os.git.status", {});
  }
  if (contains(user, "eval-ping") && contains(user, "installed skills")) {
    return oneCall("reply", { text: "yes" });
  }
  if (user.trim() === "ping") {
    return sawSkill
      ? oneCall("reply", { text: "pong-eval-ok" })
      : oneCall("skill.view", { name: "eval-ping" });
  }
  if (contains(user, "/status")) {
    if (!sawRead) return oneCall("os.fs.read", { path: "MOCK_URL.txt" });
    if (!sawHttp) {
      return oneCall("os.http.request", {
        url: `${findMockUrl(prompt)}/status`,
        method: "GET",
      });
    }
    return oneCall("reply", { text: "eval" });
  }
  if (contains(user, "/echo")) {
    if (!sawRead) return oneCall("os.fs.read", { path: "MOCK_URL.txt" });
    if (!sawHttp) {
      return oneCall("os.http.request", {
        url: `${findMockUrl(prompt)}/echo`,
        method: "POST",
        body: { token: "ECHO-7711" },
      });
    }
    return oneCall("reply", { text: "ECHO-7711" });
  }
  if (contains(user, "single sentence") && contains(user, "README.md")) {
    return sawRead
      ? oneCall("reply", {
          text: "Aurora is an edge cache for AI inference responses using prompt hashing, streaming-aware caching, TTLs, and tenant isolation.",
        })
      : oneCall("os.fs.read", { path: "README.md" });
  }
  if (contains(user, "top level + one level deep")) {
    return sawList
      ? oneCall("reply", {
          text: "There are 4 top-level entries: package.json, README.md, src/, and tests/. TypeScript files dominate src/, and tests/ is present.",
        })
      : oneCall("os.fs.list", { path: ".", maxEntries: 20 });
  }
  if (contains(user, "calculateTotal")) {
    if (sawWrite) {
      return oneCall("reply", {
        text: "Changed calculateTotal to sum price * quantity for each item. Validation not run.",
      });
    }
    if (sawRead) {
      return oneCall("os.fs.write", {
        path: "src/cart.ts",
        content:
          "export interface CartItem {\n  price: number;\n  quantity: number;\n}\n\nexport function calculateTotal(items: CartItem[]): number {\n  return items.reduce((total, item) => total + item.price * item.quantity, 0);\n}\n",
        mode: "replace",
      });
    }
    return oneCall("os.fs.read", { path: "src/cart.ts" });
  }
  if (contains(user, "slugify")) {
    if (sawWrite) {
      return oneCall("reply", {
        text: "Fixed slugify normalization. Validation not run.",
      });
    }
    if (sawRead) {
      return oneCall("os.fs.write", {
        path: "src/slug.ts",
        content:
          "export function slugify(input: string): string {\n  return input\n    .trim()\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, \"-\")\n    .replace(/^-+|-+$/g, \"\");\n}\n",
        mode: "replace",
      });
    }
    return toolArray([
      { tool: "os.fs.read", args: { path: "src/slug.ts" } },
      { tool: "os.fs.read", args: { path: "src/slug.test.ts" } },
    ]);
  }
  if (contains(user, "tax constant") || contains(user, "tax rate")) {
    if (sawWrite) {
      return oneCall("reply", {
        text: "Updated invoiceTotal to use TAX_RATE. Validation not run.",
      });
    }
    if (sawRead) {
      return oneCall("os.fs.write", {
        path: "src/invoice.ts",
        content:
          "import { TAX_RATE } from \"./tax.js\";\n\nexport function invoiceTotal(subtotal: number): number {\n  const tax = subtotal * TAX_RATE;\n  return subtotal + tax;\n}\n",
        mode: "replace",
      });
    }
    return toolArray([
      { tool: "os.fs.read", args: { path: "src/tax.ts" } },
      { tool: "os.fs.read", args: { path: "src/invoice.ts" } },
    ]);
  }
  return oneCall("reply", { text: "ok" });
}

function sendCompletion(res, requestBody) {
  const payload = completion(pickToolCall(String(requestBody.prompt ?? "")));
  if (requestBody.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  json(res, payload);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, { status: "ok" });
    return;
  }
  if (req.method === "GET" && req.url === "/props") {
    json(res, {
      model_path: "eval-stub.gguf",
      default_generation_settings: { n_ctx: 32768 },
    });
    return;
  }
  if (req.method === "POST" && req.url === "/completion") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        parsed = {};
      }
      sendCompletion(res, parsed);
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.on("error", (err) => {
  console.error(`[eval-stub] server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[eval-stub] listening on 127.0.0.1:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
