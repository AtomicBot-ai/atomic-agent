// Skill Lab check for audit: the report names the SQL injection in
// src/server.js (line 9, one line of slack) and the hard-coded admin
// password in src/config.js, and does not flag the parameterized query
// on line 14 as an injection.
import { readFileSync } from "node:fs";

const answer = readFileSync(process.env.SKILL_EVAL_ANSWER_FILE, "utf8").replace(/\\/g, "/");
const problems = [];
const serverLines = [...answer.matchAll(/server\.js:(\d+)/g)].map((m) => Number(m[1]));
if (!serverLines.some((n) => Math.abs(n - 9) <= 1)) problems.push("SQL injection at src/server.js:9 not reported");
if (serverLines.some((n) => n === 14)) problems.push("flagged the parameterized query at src/server.js:14");
if (!/config\.js/.test(answer) || !/password|secret|credential/i.test(answer)) problems.push("hard-coded password in src/config.js not reported");
if (problems.length > 0) {
  console.error(problems.join("; "));
  process.exit(1);
}
