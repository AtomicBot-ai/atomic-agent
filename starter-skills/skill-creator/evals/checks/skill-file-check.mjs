// Skill Lab check for skill-creator: skills/<name>/SKILL.md exists in the
// working folder and would load: frontmatter first, name equal to the
// folder, non-empty description and version, a description with ": " in
// it quoted (unquoted it is not valid YAML).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2];
const path = join("skills", name, "SKILL.md");
let text;
try {
  text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
} catch {
  console.error(`${path} not found`);
  process.exit(1);
}
const problems = [];
const match = text.match(/^---\n([\s\S]*?)\n---\n/);
if (!match) {
  console.error("SKILL.md does not start with a --- frontmatter block");
  process.exit(1);
}
const fields = Object.fromEntries(
  match[1].split("\n").map((l) => l.match(/^([A-Za-z_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
);
const unquote = (v) => (v ?? "").replace(/^(['"])(.*)\1$/, "$2");
if (unquote(fields.name) !== name) problems.push(`name is ${JSON.stringify(fields.name)}, expected ${name}`);
if (!unquote(fields.description)) problems.push("description is empty");
if (!unquote(fields.version)) problems.push("version is empty");
const desc = fields.description ?? "";
if (desc.includes(": ") && !/^(['"]).*\1$/.test(desc)) problems.push('description has ": " but is not quoted');
if (text.slice(match[0].length).trim() === "") problems.push("body is empty");
if (problems.length > 0) {
  console.error(problems.join("; "));
  process.exit(1);
}
