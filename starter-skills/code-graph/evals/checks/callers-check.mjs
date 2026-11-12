// Skill Lab check for code-graph: the reply names both real callers of
// chargeCard with path:line (one line of slack), and none of the decoys.
import { readFileSync } from "node:fs";

const answer = readFileSync(process.env.SKILL_EVAL_ANSWER_FILE, "utf8").replace(/\\/g, "/");
const callers = [
  ["src/checkout/handler.js", 7],
  ["src/subscriptions/renew.js", 8],
];
const problems = [];
for (const [file, line] of callers) {
  const re = new RegExp(`${file.replace(/[.]/g, "\\.")}:(\\d+)`, "g");
  const lines = [...answer.matchAll(re)].map((m) => Number(m[1]));
  if (!lines.some((n) => Math.abs(n - line) <= 1)) problems.push(`missing ${file}:${line}`);
}
if (/refund-tool\.js/.test(answer)) problems.push("named refund-tool.js, which only mentions chargeCard in a comment and a string");
if (problems.length > 0) {
  console.error(problems.join("; "));
  process.exit(1);
}
