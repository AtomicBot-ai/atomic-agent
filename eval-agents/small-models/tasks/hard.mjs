// h1–h5: harder offline tasks from ATO-787. Each targets one failure we saw
// on small local models: edits that span files, edits deep inside a long
// file (small models rewrite the whole file and drop parts), project-wide
// search with decoys, recovering after a command fails, and writing HTML
// with literal "\n" sequences instead of real newlines (Nemotron, 21.10).

import { fail, makeRng, pass, readText, run, sha256, squash, writeFiles } from "../lib/util.mjs";

// ---------------------------------------------------------------- h1 ----

const H1_FILES = {
  "shop/settings.py": `CURRENCY = "$"
DISCOUNT = 0.2  # member discount, not the tax rate
`,
  "shop/cart.py": `def cart_total(prices):
    subtotal = sum(prices)
    return round(subtotal + subtotal * 0.2, 2)
`,
  "shop/invoice.py": `def invoice_line(name, price):
    tax = round(price * 0.2, 2)
    return f"{name}: {price:.2f} + tax {tax:.2f}"
`,
  "shop/receipt.py": `def tax_note():
    return f"Tax rate: {int(round(0.2 * 100))}%"
`,
  "shop/main.py": `import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cart import cart_total
from invoice import invoice_line
from receipt import tax_note
from settings import DISCOUNT

prices = [10.0, 25.6, 4.4]
for name, price in zip(["pen", "lamp", "tape"], prices):
    print(invoice_line(name, price))
print("total:", f"{cart_total(prices):.2f}")
print(tax_note())
print("member discount:", DISCOUNT)
`,
};

const H1_OUTPUT = [
  "pen: 10.00 + tax 2.50",
  "lamp: 25.60 + tax 6.40",
  "tape: 4.40 + tax 1.10",
  "total: 50.00",
  "Tax rate: 25%",
  "member discount: 0.2",
].join("\n");

const h1 = {
  id: "h1",
  set: "core",
  title: "multi-step edit across files (one constant, three importers)",
  timeoutSec: 900,
  maxSteps: 40,
  turns: () => [
    "In the folder shop/, the tax rate 0.2 is hard-coded in three files: cart.py, invoice.py and receipt.py. " +
      "Add a constant TAX_RATE = 0.25 to shop/settings.py. Then change cart.py, invoice.py and receipt.py so each one imports TAX_RATE from settings and uses it instead of the number. " +
      "Do not change DISCOUNT in settings.py. At the end run `python3 shop/main.py` and check that it prints tax 2.50 for the pen.",
  ],
  fixture(dir) {
    writeFiles(dir, H1_FILES);
    return { output: H1_OUTPUT };
  },
  check(dir, meta) {
    const settings = readText(dir, "shop/settings.py");
    if (settings === null) return fail("shop/settings.py missing");
    if (!/^TAX_RATE\s*=\s*0\.25\s*(#.*)?$/m.test(settings)) return fail("settings.py has no TAX_RATE = 0.25");
    if (!/^DISCOUNT\s*=\s*0\.2\b/m.test(settings)) return fail("DISCOUNT was changed");
    for (const f of ["cart.py", "invoice.py", "receipt.py"]) {
      const t = readText(dir, `shop/${f}`);
      if (t === null) return fail(`shop/${f} missing`);
      if (/(^|[^\d.])0\.2(?!\d)/.test(t.replace(/#.*$/gm, ""))) return fail(`${f} still has 0.2`);
      if (!/^\s*from\s+settings\s+import\s+[^\n]*\bTAX_RATE\b|^\s*import\s+settings\b/m.test(t)) return fail(`${f} does not import TAX_RATE`);
      if (!t.includes("TAX_RATE")) return fail(`${f} does not use TAX_RATE`);
    }
    const r = run("python3", ["shop/main.py"], { cwd: dir });
    const got = r.stdout.replace(/\n+$/, "");
    return r.code === 0 && got === meta.output ? pass() : fail(`main.py output wrong: '${got.split("\n")[0] ?? ""}…'`);
  },
  solve(dir) {
    writeFiles(dir, {
      "shop/settings.py": `CURRENCY = "$"
DISCOUNT = 0.2  # member discount, not the tax rate
TAX_RATE = 0.25
`,
      "shop/cart.py": H1_FILES["shop/cart.py"].replace("def", "from settings import TAX_RATE\n\n\ndef").replace("0.2", "TAX_RATE"),
      "shop/invoice.py": H1_FILES["shop/invoice.py"].replace("def", "from settings import TAX_RATE\n\n\ndef").replace("0.2", "TAX_RATE"),
      "shop/receipt.py": H1_FILES["shop/receipt.py"].replace("def", "from settings import TAX_RATE\n\n\ndef").replace("0.2", "TAX_RATE"),
    });
  },
};

// ---------------------------------------------------------------- h2 ----

const PARSE_BODY = (ret) => [
  "    total = 0",
  '    for amount, unit in re.findall(r"(\\d+)([hms])", text):',
  "        n = int(amount)",
  '        if unit == "h":',
  "            total += n * 3600",
  '        elif unit == "m":',
  "            total += n * 60",
  "        else:",
  "            total += n",
  `    return ${ret}`,
];

/** ~2.4k-line module; parse_duration (near line 1900) returns minutes instead of seconds. */
export function makeBigModule(seed = "h2") {
  const rng = makeRng(seed);
  const out = ["import re", "", ""];
  const ops = ["v * K", "v + K", "v - K", "abs(v) * K", "v * v + K"];
  for (let i = 1; i <= 340; i += 1) {
    if (i === 120) {
      out.push("def parse_duration_ms(text):", "    \"\"\"'1h30m' -> milliseconds.\"\"\"", ...PARSE_BODY("total * 1000"), "", "");
    }
    if (i === 270) {
      out.push("def parse_duration(text):", "    \"\"\"'1h30m15s' -> seconds.\"\"\"", ...PARSE_BODY("total // 60"), "", "");
    }
    const k = rng.int(2, 9);
    const op = rng.pick(ops).replace("K", String(k));
    const name = `metric_${String(i).padStart(4, "0")}`;
    out.push(`def ${name}(values):`, `    """Aggregate ${op} over values."""`, "    total = 0", "    for v in values:", `        total += ${op}`, "    return total", "", "");
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** [start, end) line range of a top-level `def name(` block (end = next top-level def/EOF, trailing blanks excluded). */
export function defRange(lines, name) {
  const start = lines.findIndex((l) => l.startsWith(`def ${name}(`));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(def |class |[A-Za-z_])/.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
  return [start, end];
}

/** Only the parse_duration block may differ; everything around it must be byte-identical. */
export function onlyFunctionChanged(original, edited, name) {
  const o = original.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  const n = edited.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  const ro = defRange(o, name);
  const rn = defRange(n, name);
  if (!ro || !rn) return `def ${name} not found`;
  if (rn[0] !== ro[0]) return `${ro[0] - rn[0]} line(s) changed or removed before ${name}`;
  for (let i = 0; i < ro[0]; i += 1) if (o[i] !== n[i]) return `line ${i + 1} changed (outside ${name})`;
  const tailO = o.slice(ro[1]);
  const tailN = n.slice(rn[1]);
  const trim = (a) => {
    let i = 0;
    while (i < a.length && a[i].trim() === "") i += 1;
    return a.slice(i);
  };
  const a = trim(tailO);
  const b = trim(tailN);
  if (a.length !== b.length) return `${a.length - b.length} line(s) lost after ${name} (file rewritten?)`;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return `a line after ${name} changed`;
  return null;
}

const H2_TEST = `import sys
sys.path.insert(0, "lib")
from big_module import parse_duration, parse_duration_ms

assert parse_duration("1h30m15s") == 5415, parse_duration("1h30m15s")
assert parse_duration("90s") == 90, parse_duration("90s")
assert parse_duration_ms("2m") == 120000
print("all tests passed")
`;

const H2_HIDDEN = `import sys
sys.path.insert(0, "lib")
from big_module import parse_duration, parse_duration_ms
for raw, want in {"2h": 7200, "45s": 45, "1h1m1s": 3661, "": 0, "10m": 600}.items():
    assert parse_duration(raw) == want, (raw, parse_duration(raw))
assert parse_duration_ms("1s") == 1000
print("hidden ok")
`;

const h2 = {
  id: "h2",
  set: "core",
  title: "small fix deep inside a >2k-line file without rewriting it",
  timeoutSec: 900,
  maxSteps: 40,
  turns: () => [
    "lib/big_module.py is a long file (over 2000 lines). Its function parse_duration returns the wrong value: run `python3 test_big.py` to see the failure. " +
      "Fix only the function parse_duration (not parse_duration_ms). Do not rewrite, reformat or shorten the rest of the file: make a small targeted edit. Run the test again to confirm it passes.",
  ],
  fixture(dir) {
    const text = makeBigModule();
    writeFiles(dir, { "lib/big_module.py": text, "test_big.py": H2_TEST });
    return { lines: text.split("\n").length - 1, sha: sha256(text) };
  },
  check(dir) {
    const original = makeBigModule();
    const edited = readText(dir, "lib/big_module.py");
    if (edited === null) return fail("lib/big_module.py missing");
    if (readText(dir, "test_big.py") !== H2_TEST) return fail("test_big.py was modified");
    const drift = onlyFunctionChanged(original, edited, "parse_duration");
    if (drift) return fail(drift);
    if (run("python3", ["test_big.py"], { cwd: dir }).code !== 0) return fail("visible test still fails");
    return run("python3", ["-"], { cwd: dir, input: H2_HIDDEN }).code === 0 ? pass() : fail("hidden cases fail (hardcoded?)");
  },
  solve(dir) {
    writeFiles(dir, { "lib/big_module.py": makeBigModule().replace("    return total // 60\n", "    return total\n") });
  },
};

// ---------------------------------------------------------------- h3 ----

const PKGS = ["api", "billing", "core", "events", "jobs", "notify", "storage", "utils"];
const VERBS = ["load", "save", "build", "parse", "render", "sync", "check", "merge", "split", "queue"];
const NOUNS = ["order", "user", "invoice", "report", "event", "batch", "token", "session", "plan", "item"];

/** ~80-file tree; exactly one `def send_webhook(`; decoys: send_webhook_legacy, comments, stale notes, other WEBHOOK_TIMEOUTs. */
export function makeSearchProject(seed = "h3") {
  const rng = makeRng(seed);
  const paths = [];
  for (const p of PKGS) for (let i = 1; i <= 10; i += 1) paths.push(`src/${p}/mod_${String(i).padStart(2, "0")}.py`);
  const target = paths[rng.int(10, paths.length - 1)];
  let legacy = target;
  while (legacy === target) legacy = rng.pick(paths);
  const value = rng.int(11, 97);
  const decoyValues = new Map();
  while (decoyValues.size < 4) {
    const p = rng.pick(paths);
    if (p !== target) decoyValues.set(p, rng.int(100, 300));
  }
  decoyValues.set(legacy, value + rng.int(3, 9));
  const files = {};
  for (const p of paths) {
    const lines = ['"""Module ' + p + '."""', ""];
    if (decoyValues.has(p)) lines.push(`WEBHOOK_TIMEOUT = ${decoyValues.get(p)}`, "");
    if (p === target) lines.push(`WEBHOOK_TIMEOUT = ${value}`, "");
    const n = rng.int(3, 6);
    for (let i = 0; i < n; i += 1) {
      const fn = `${rng.pick(VERBS)}_${rng.pick(NOUNS)}_${i}`;
      lines.push("", `def ${fn}(data):`);
      if (rng.next() < 0.08) lines.push("    # TODO: call send_webhook here once the API is stable");
      lines.push(`    return {"${fn}": data}`, "");
    }
    if (p === target) lines.push("", "def send_webhook(url, payload):", "    return {\"url\": url, \"payload\": payload, \"timeout\": WEBHOOK_TIMEOUT}", "");
    if (p === legacy) lines.push("", "def send_webhook_legacy(url, payload):", "    return {\"url\": url, \"timeout\": WEBHOOK_TIMEOUT}", "");
    files[p] = `${lines.join("\n")}\n`;
  }
  for (const p of PKGS) files[`src/${p}/__init__.py`] = "";
  files["docs/NOTES.md"] = `# Notes\n\nsend_webhook used to live in ${legacy}, it moved during the refactor.\n`;
  return { files, answer: `${target}:${value}` };
}

const h3 = {
  id: "h3",
  set: "core",
  title: "project-wide search with decoys",
  timeoutSec: 900,
  maxSteps: 40,
  turns: () => [
    "Somewhere under src/ there is a Python function named exactly send_webhook (not send_webhook_legacy). Find the file that defines it, and the value of WEBHOOK_TIMEOUT in that same file. " +
      "Write one line into answer.txt in the current folder: the file path relative to the current folder, a colon, and the value. Example: src/a/mod_01.py:30",
  ],
  fixture(dir) {
    const { files, answer } = makeSearchProject();
    writeFiles(dir, files);
    return { answer };
  },
  check(dir, meta) {
    const a = readText(dir, "answer.txt");
    if (a === null) return fail("answer.txt missing");
    const got = squash(a).replace(/^\.\//, "");
    return got === meta.answer ? pass() : fail(`answer.txt='${got.slice(0, 50)}'`);
  },
  solve(dir, meta) {
    writeFiles(dir, { "answer.txt": `${meta.answer}\n` });
  },
};

// ---------------------------------------------------------------- h4 ----

const H4_BUILD = `#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -f VERSION ]; then
  echo "error: VERSION file is missing. Create a file named VERSION that contains exactly 2.7.1, then run ./build.sh again." >&2
  exit 3
fi
v=$(tr -d ' \\r\\n' < VERSION)
if [ "$v" != "2.7.1" ]; then
  echo "error: VERSION must be 2.7.1, got '$v'" >&2
  exit 4
fi
if [ ! -f config/build.env ]; then
  echo "error: config/build.env is missing. Create it with the single line TARGET=release, then run ./build.sh again." >&2
  exit 5
fi
. config/build.env
if [ "$TARGET" != "release" ]; then
  echo "error: TARGET must be release, got '$TARGET'" >&2
  exit 6
fi
mkdir -p dist
printf 'build %s %s %s\\n' "$v" "$TARGET" "$(cat src/*.txt | wc -c | tr -d ' ')" > dist/out.txt
echo "build ok"
`;

const H4_SRC = {
  "src/a.txt": "alpha module\n",
  "src/b.txt": "beta module, second part\n",
  "src/c.txt": "gamma\n",
};

const h4 = {
  id: "h4",
  set: "core",
  title: "recover after a failing command (two planted errors)",
  timeoutSec: 900,
  maxSteps: 40,
  turns: () => [
    "Run ./build.sh in the current folder to produce dist/out.txt. If it fails, read the error message, fix the cause, and run ./build.sh again. " +
      "Repeat until it prints build ok. Do not edit build.sh and do not write dist/out.txt yourself.",
  ],
  fixture(dir) {
    writeFiles(dir, { "build.sh!x": H4_BUILD, ...H4_SRC });
    const bytes = Object.values(H4_SRC).reduce((n, t) => n + Buffer.byteLength(t), 0);
    return { out: `build 2.7.1 release ${bytes}`, buildSha: sha256(H4_BUILD) };
  },
  check(dir, meta, ctx = {}) {
    const b = readText(dir, "build.sh");
    if (b === null || sha256(b) !== meta.buildSha) return fail("build.sh was modified or deleted");
    const out = readText(dir, "dist/out.txt");
    if (out === null) return fail("dist/out.txt missing");
    if (out.replace(/\n+$/, "") !== meta.out) return fail(`dist/out.txt='${out.trim().slice(0, 40)}'`);
    // Re-run the real build: hand-written VERSION/config must actually work.
    const r = run("bash", ["build.sh"], { cwd: dir });
    if (r.code !== 0) return fail(`build.sh still fails: ${r.stderr.trim().slice(0, 60)}`);
    const reruns = (ctx.trace?.toolCalls ?? []).filter((c) => JSON.stringify(c.args).includes("build.sh")).length;
    return { pass: true, reason: "", details: { buildShCalls: reruns } };
  },
  solve(dir) {
    writeFiles(dir, { VERSION: "2.7.1\n", "config/build.env": "TARGET=release\n" });
    run("bash", ["build.sh"], { cwd: dir });
  },
};

// ---------------------------------------------------------------- h5 ----

const H5_ITEMS = [
  "Bump the version",
  "Update the changelog",
  "Run the smoke tests",
  "Build signed installers",
  "Publish the release notes",
  "Update download links",
];

/** Pure HTML checker, exported for tests. */
export function checkHtml(html, items, title) {
  if (html === null) return fail("index.html missing");
  if (/\\[nt]/.test(html)) return fail('index.html contains a literal "\\n" or "\\t" sequence');
  const realLines = html.split("\n").filter((l) => l.trim().length > 0).length;
  if (realLines < items.length + 2) return fail(`index.html has only ${realLines} real line(s)`);
  if (/<script\b/i.test(html)) return fail("index.html has a <script>");
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) return fail("not a complete html document");
  const t = html.match(/<title>\s*([^<]*?)\s*<\/title>/i)?.[1];
  if (t !== title) return fail(`title='${t ?? ""}'`);
  const h1 = html.match(/<h1[^>]*>\s*([^<]*?)\s*<\/h1>/i)?.[1];
  if (h1 !== title) return fail(`h1='${h1 ?? ""}'`);
  const lis = [...html.matchAll(/<li[^>]*>\s*([^<]*?)\s*<\/li>/gi)].map((m) => m[1]);
  if (lis.length !== items.length || lis.some((x, i) => x !== items[i])) return fail(`li items differ (${lis.length} found)`);
  return pass();
}

const h5 = {
  id: "h5",
  set: "core",
  title: "write an HTML file with real newlines (no literal \\n)",
  timeoutSec: 600,
  maxSteps: 25,
  turns: () => [
    'Write index.html in the current folder: a complete HTML page with the title "Release checklist", an <h1> with the same text, and a <ul> with one <li> per line of items.txt, in the same order and with the same text. ' +
      "Put each tag on its own line. No JavaScript.",
  ],
  fixture(dir) {
    writeFiles(dir, { "items.txt": `${H5_ITEMS.join("\n")}\n` });
    return { items: H5_ITEMS, title: "Release checklist" };
  },
  check(dir, meta) {
    return checkHtml(readText(dir, "index.html"), meta.items, meta.title);
  },
  solve(dir, meta) {
    const li = meta.items.map((x) => `    <li>${x}</li>`).join("\n");
    writeFiles(dir, {
      "index.html": `<!DOCTYPE html>\n<html>\n<head>\n  <title>${meta.title}</title>\n</head>\n<body>\n  <h1>${meta.title}</h1>\n  <ul>\n${li}\n  </ul>\n</body>\n</html>\n`,
    });
  },
};

export default [h1, h2, h3, h4, h5];
