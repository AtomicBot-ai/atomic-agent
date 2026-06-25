import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { seedConfigJson } from "../../eval-memory/harness/memory-profiles.ts";

const REPO = resolve(".");
const TASK = "1f975693-876d-457b-a649-393859e79bf3";
const MP3 = `eval-agents/datasets/gaia/hf/2023/validation/${TASK}.mp3`;

const meta = readFileSync(
  "eval-agents/datasets/gaia/hf/2023/validation/metadata.jsonl",
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const row = meta.find((m) => m.task_id === TASK);
const question = row.Question.replace(/\s+/g, " ").trim();
const gold = row["Final answer"];

const base = mkdtempSync(join(tmpdir(), "audio-skill-"));
const work = join(base, "cwd");
const state = join(base, "state");
mkdirSync(work, { recursive: true });
mkdirSync(state, { recursive: true });
copyFileSync(MP3, join(work, `${TASK}.mp3`));

seedConfigJson(state, "on", {
  llamaUrl: "http://127.0.0.1:19091",
  maxSteps: 15,
  embeddings: { enabled: false },
});

const prompt =
  "You are solving a GAIA benchmark question. Use tools as needed " +
  "(filesystem, web, documents). When finished, your last line MUST be " +
  "exactly: FINAL ANSWER: <your answer>. The answer must match GAIA rules: " +
  "a short string, a number, or a comma-separated list — no extra " +
  `explanation on that line. Attached file(s) are in the workspace: ${TASK}.mp3. ` +
  `Question: ${question}`;

console.log("GOLD:", gold);
console.log("WORKDIR:", work);

const child = spawn(
  process.execPath,
  [
    join(REPO, "dist", "cli", "index.js"),
    "run",
    "--cwd",
    work,
    "--no-approval",
    "--max-steps",
    "15",
  ],
  {
    cwd: REPO,
    env: {
      ...process.env,
      ATOMIC_AGENT_STATE_DIR: state,
      ATOMIC_AGENT_LLAMA_URL: "http://127.0.0.1:19091",
      ATOMIC_AGENT_STARTER_SKILLS_DIR: join(REPO, "starter-skills"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

child.stdin.write(`${prompt}\n`);
child.stdin.end();

let out = "";
let err = "";
child.stdout.on("data", (c) => {
  const s = c.toString("utf8");
  out += s;
  process.stdout.write(s);
});
child.stderr.on("data", (c) => {
  err += c.toString("utf8");
});
const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
child.on("close", (code) => {
  clearTimeout(timer);
  console.log("\n==== exit:", code, "====");
  // show which skills got seeded
  try {
    const skills = readdirSync(join(state, "skills"));
    console.log("seeded skills:", skills.join(", "));
  } catch {
    console.log("no seeded skills dir");
  }
  if (err.trim()) console.log("STDERR tail:\n", err.slice(-1500));
});
