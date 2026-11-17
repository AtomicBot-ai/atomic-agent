// Skill Lab check for plain-writing. Usage:
//   node plain-check.mjs file <path> <fact>...   checks a file
//   node plain-check.mjs answer <fact>...        checks the reply (SKILL_EVAL_ANSWER_FILE)
// Fails on long or en dashes, on the stock phrases below, or on a missing fact.
import { readFileSync } from "node:fs";

const [mode, ...rest] = process.argv.slice(2);
const path = mode === "file" ? rest.shift() : process.env.SKILL_EVAL_ANSWER_FILE;
const facts = rest;
let text;
try {
  text = readFileSync(path, "utf8");
} catch {
  console.error(`cannot read ${path}`);
  process.exit(1);
}
const lower = text.toLowerCase();
const problems = [];
if (/[—–]/.test(text)) problems.push("long or en dash left in");
const stock = [
  "supercharge", "fast-paced", "crucial", "seamless", "game-changer", "robust", "cutting-edge",
  "let's be honest", "in conclusion", "unlock", "delve", "empower", "it's not just",
];
for (const phrase of stock) if (lower.includes(phrase)) problems.push(`stock phrase: ${phrase}`);
for (const fact of facts) if (!lower.includes(fact.toLowerCase())) problems.push(`fact missing: ${fact}`);
if (problems.length > 0) {
  console.error(problems.join("; "));
  process.exit(1);
}
