// t1–t5: the five offline tasks of the 20.10 Qwen3.5-4B ten-agent bench,
// ported 1:1 (same prompts, same expected answers) so numbers stay comparable.
// Checker fix vs the old stand: t5 counted __pycache__/*.pyc as matches with
// GNU grep (`grep -rl` reports binary files), so a correct rename showed up as
// "new name not in all 3 files". We now scan *.py sources only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { fail, lastLine, pass, readText, run, squash, writeFiles } from "../lib/util.mjs";

const t1 = {
  id: "t1",
  set: "core",
  title: "read a YAML value into a file",
  timeoutSec: 600,
  maxSteps: 25,
  turns: () => [
    "Read config.yaml in the current folder. Find the port of the database (not the cache). Write only that number into a new file answer.txt in the current folder.",
  ],
  fixture(dir) {
    writeFiles(dir, {
      "config.yaml": [
        "app:",
        "  name: inventory-service",
        "  debug: false",
        "database:",
        "  host: db.internal",
        "  port: 5433",
        "  user: inventory",
        "cache:",
        "  host: redis.internal",
        "  port: 6379",
        "",
      ].join("\n"),
    });
    return { port: "5433" };
  },
  check(dir, meta) {
    const a = readText(dir, "answer.txt");
    if (a === null) return fail("answer.txt missing");
    return squash(a) === meta.port ? pass() : fail(`answer.txt='${a.slice(0, 40)}'`);
  },
  solve(dir, meta) {
    writeFiles(dir, { "answer.txt": `${meta.port}\n` });
  },
};

const T2_NUMBERS = [
  318, 779, 335, 345, 352, -90, -83, -74, 381, 393, -52, -43, 410, -30, 428, -13, -9, 1, 465, 19,
  28, 485, 40, 50, 61, 513, 71, 81, 536, 545, 102, 563, 115, 128, 136, 594, 599, 159, 166, 175,
];

const t2 = {
  id: "t2",
  set: "core",
  title: "write and run a script",
  timeoutSec: 600,
  maxSteps: 25,
  turns: () => [
    "Create a Python script stats.py in the current folder. It must read numbers.txt (one integer per line) and print exactly one line in the format: sum=<sum> min=<min> max=<max>. Then run the script with python3 and save its output into result.txt.",
  ],
  fixture(dir) {
    writeFiles(dir, { "numbers.txt": `${T2_NUMBERS.join("\n")}\n` });
    const sum = T2_NUMBERS.reduce((a, b) => a + b, 0);
    return { want: `sum=${sum} min=${Math.min(...T2_NUMBERS)} max=${Math.max(...T2_NUMBERS)}` };
  },
  check(dir, meta) {
    if (readText(dir, "stats.py") === null) return fail("stats.py missing");
    const r = run("python3", ["stats.py"], { cwd: dir });
    const got = lastLine(r.stdout + r.stderr);
    if (got !== meta.want) return fail(`stats.py printed '${got}', want '${meta.want}'`);
    const res = readText(dir, "result.txt");
    if (res === null) return fail("result.txt missing");
    return lastLine(res) === meta.want ? pass() : fail("result.txt wrong");
  },
  solve(dir, meta) {
    writeFiles(dir, {
      "stats.py": [
        "n = [int(x) for x in open('numbers.txt') if x.strip()]",
        "print(f'sum={sum(n)} min={min(n)} max={max(n)}')",
        "",
      ].join("\n"),
      "result.txt": `${meta.want}\n`,
    });
  },
};

const T3_TEST = `from utils import slugify

cases = {
    "Hello World": "hello-world",
    "  Local LLMs, explained!  ": "local-llms-explained",
    "Qwen 3.5 -- 4B": "qwen-3-5-4b",
    "already-a-slug": "already-a-slug",
}
for raw, want in cases.items():
    got = slugify(raw)
    assert got == want, f"slugify({raw!r}) = {got!r}, want {want!r}"
print("all tests passed")
`;

const T3_UTILS = `import re


def slugify(title):
    """Turn a title into a URL slug: lowercase, words joined by single dashes,
    no leading or trailing dashes, only a-z and 0-9 kept."""
    text = title.lower()
    text = re.sub(r"[^a-z0-9]", "-", text)
    return text
`;

const T3_HIDDEN = `import sys
sys.path.insert(0, ".")
from utils import slugify
for raw, want in {"Mixed__Case  Title": "mixed-case-title", "!!!Edge!!!": "edge", "C++ & Rust 2026": "c-rust-2026"}.items():
    assert slugify(raw) == want, (raw, slugify(raw))
print("hidden ok")
`;

const t3 = {
  id: "t3",
  set: "core",
  title: "fix a bug so a test passes (hidden cases catch hardcoding)",
  timeoutSec: 600,
  maxSteps: 25,
  turns: () => [
    "Running `python3 test_utils.py` in the current folder fails. Fix the bug in utils.py so that the test passes. Do not change test_utils.py. Run the test at the end to confirm it passes.",
  ],
  fixture(dir) {
    writeFiles(dir, { "test_utils.py": T3_TEST, "utils.py": T3_UTILS });
    return {};
  },
  check(dir) {
    if (readText(dir, "test_utils.py") !== T3_TEST) return fail("test_utils.py was modified");
    if (run("python3", ["test_utils.py"], { cwd: dir }).code !== 0) return fail("visible test still fails");
    const h = run("python3", ["-"], { cwd: dir, input: T3_HIDDEN });
    return h.code === 0 ? pass() : fail("hidden cases fail (hardcoded?)");
  },
  solve(dir) {
    writeFiles(dir, {
      "utils.py": `import re


def slugify(title):
    text = re.sub(r"[^a-z0-9]+", "-", title.lower())
    return text.strip("-")
`,
    });
  },
};

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** The original 20.10 logs (180 lines, committed): 43 ERROR lines, top "connection reset by peer". */
export function t4Files() {
  const files = {};
  for (const name of ["api", "cron", "worker"]) {
    files[`logs/${name}.log`] = readFileSync(join(FIXTURES, "t4", "logs", `${name}.log`), "utf8");
  }
  return files;
}

/** Expected answers recomputed from the logs, so a fixture edit cannot silently desync the checker. */
export function t4Expected(files) {
  const counts = {};
  let errors = 0;
  for (const text of Object.values(files)) {
    for (const line of text.split("\n")) {
      const m = line.match(/ ERROR (.+)$/);
      if (!m) continue;
      errors += 1;
      counts[m[1].trim()] = (counts[m[1].trim()] ?? 0) + 1;
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return { errors: String(errors), top };
}

const t4 = {
  id: "t4",
  set: "core",
  title: "multi-file log counting",
  timeoutSec: 600,
  maxSteps: 25,
  turns: () => [
    "The folder logs/ contains several log files. Count how many lines with the level ERROR there are across all files, and write just that number into errors.txt. Then find the most frequent ERROR message (the text after the word ERROR) and write it into top_error.txt.",
  ],
  fixture(dir) {
    const files = t4Files();
    writeFiles(dir, files);
    return t4Expected(files);
  },
  check(dir, meta) {
    // The prompt does not say "current folder", so files next to the logs count too.
    const e = readText(dir, "errors.txt") ?? readText(dir, "logs/errors.txt");
    const te = readText(dir, "top_error.txt") ?? readText(dir, "logs/top_error.txt");
    if (squash(e) !== meta.errors) return fail(`errors.txt='${(e ?? "").slice(0, 40)}' want ${meta.errors}`);
    const first = (te ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return first === meta.top ? pass() : fail(`top_error.txt='${first.slice(0, 60)}'`);
  },
  solve(dir, meta) {
    writeFiles(dir, { "errors.txt": `${meta.errors}\n`, "top_error.txt": `${meta.top}\n` });
  },
};

const T5_FILES = {
  "app/main.py": `import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from report import line_for
from users import get_user_name

for uid in (1, 2, 3, 4):
    print(line_for(uid))
print("first:", get_user_name(1))
`,
  "app/report.py": `from users import get_user_name


def line_for(user_id):
    return f"#{user_id}: {get_user_name(user_id)}"
`,
  "app/users.py": `USERS = {1: "ada", 2: "linus", 3: "grace"}


def get_user_name(user_id):
    return USERS.get(user_id, "unknown")
`,
};

/** *.py sources under `root`, skipping __pycache__ (the GNU-grep false count). */
export function pySources(root) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "__pycache__") continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".py")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

const t5 = {
  id: "t5",
  set: "core",
  title: "rename a function across 3 files without changing output",
  timeoutSec: 600,
  maxSteps: 25,
  turns: () => [
    "In the folder app/, rename the function get_user_name to fetch_username everywhere: its definition and every place where it is imported or called. After the change, `python3 app/main.py` must print exactly the same output as before. Run it to confirm.",
  ],
  fixture(dir) {
    writeFiles(dir, T5_FILES);
    return { output: "#1: ada\n#2: linus\n#3: grace\n#4: unknown\nfirst: ada" };
  },
  check(dir, meta) {
    let files;
    try {
      files = pySources(join(dir, "app"));
    } catch {
      return fail("app/ missing");
    }
    const texts = files.map((f) => [relative(dir, f), readText(dir, relative(dir, f)) ?? ""]);
    if (texts.some(([, t]) => t.includes("get_user_name"))) return fail("old name still present");
    const withNew = texts.filter(([, t]) => t.includes("fetch_username")).length;
    if (withNew !== 3) return fail(`new name in ${withNew} .py files, want 3`);
    const r = run("python3", ["app/main.py"], { cwd: dir });
    return r.stdout.replace(/\n+$/, "") === meta.output && r.code === 0 ? pass() : fail("output changed");
  },
  solve(dir) {
    const files = {};
    for (const [rel, text] of Object.entries(T5_FILES)) files[rel] = text.replaceAll("get_user_name", "fetch_username");
    writeFiles(dir, files);
  },
};

export default [t1, t2, t3, t4, t5];
