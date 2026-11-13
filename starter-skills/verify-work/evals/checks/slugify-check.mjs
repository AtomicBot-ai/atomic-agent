// Skill Lab check for verify-work: the project's tests pass and the test file is unchanged.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const expected = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "slugify.test.expected.mjs"), "utf8");
if (readFileSync("slugify.test.mjs", "utf8") !== expected) {
  console.error("slugify.test.mjs was changed");
  process.exit(1);
}
try {
  execFileSync(process.execPath, ["--test", "slugify.test.mjs"], { stdio: "pipe" });
} catch (err) {
  console.error(String(err.stdout ?? err.message).slice(-500));
  process.exit(1);
}
