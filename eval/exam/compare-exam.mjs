#!/usr/bin/env node
// Compares two release exam results: `npm run eval:exam:compare -- <old> <new>`.
//
// Exit codes:
//   0  no meaningful drop in the pass count
//   1  the pass count dropped by more than the threshold (default 2)
//   2  the runs cannot be compared fairly: different model, different
//      cases, an unfinished file, or a case that did not run

import { readFileSync } from "node:fs";

const USAGE = "Usage: npm run eval:exam:compare -- <old.json> <new.json> [--threshold N]";

function stop(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const paths = [];
  let threshold = 2;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--threshold") {
      threshold = Number(argv[index + 1]);
      if (!Number.isInteger(threshold) || threshold < 0) {
        stop(`--threshold expects a whole number of 0 or more. ${USAGE}`);
      }
      index += 1;
    } else {
      paths.push(argv[index]);
    }
  }
  if (paths.length !== 2) stop(USAGE);
  return { oldPath: paths[0], newPath: paths[1], threshold };
}

function load(path) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    stop(`Could not read ${path}: ${err.message}`);
  }
  if (report.schema !== 1 || !Array.isArray(report.cases)) {
    stop(`${path} is not a release exam result.`);
  }
  return report;
}

/** Reasons the two runs are not the same exam; empty when they are. */
function findMismatches(before, after, oldById, newById) {
  const problems = [];
  if (before.complete !== true) problems.push("The old run never finished.");
  if (after.complete !== true) problems.push("The new run never finished.");
  if (before.model !== after.model) {
    problems.push(`They used different models: ${before.model} and ${after.model}.`);
  }
  const removed = [...oldById.keys()].filter((id) => !newById.has(id));
  const added = [...newById.keys()].filter((id) => !oldById.has(id));
  if (removed.length > 0) problems.push(`Cases only in the old run: ${removed.join(", ")}.`);
  if (added.length > 0) problems.push(`Cases only in the new run: ${added.join(", ")}.`);
  const edited = [...oldById.values()]
    .filter((entry) => newById.has(entry.id) && newById.get(entry.id).digest !== entry.digest)
    .map((entry) => entry.id);
  if (edited.length > 0) problems.push(`Cases whose prompt or checks changed: ${edited.join(", ")}.`);
  return problems;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Medians over only the cases that have the value in both runs, so both sides match. */
function pairedMedians(pairs, field) {
  const both = pairs.filter(
    ({ before, after }) => typeof before[field] === "number" && typeof after[field] === "number",
  );
  return {
    before: median(both.map(({ before }) => before[field])),
    after: median(both.map(({ after }) => after[field])),
  };
}

function describeChange({ before, after }, format) {
  if (before === null || after === null) return "no data";
  const percent = before === 0 ? "" : ` (${after >= before ? "+" : ""}${(((after - before) / before) * 100).toFixed(0)}%)`;
  return `${format(before)} -> ${format(after)}${percent}`;
}

function votes(entry) {
  return `${entry.passVotes}/${entry.attemptsRun} attempts passed`;
}

const { oldPath, newPath, threshold } = parseArgs(process.argv.slice(2));
const before = load(oldPath);
const after = load(newPath);
const oldById = new Map(before.cases.map((entry) => [entry.id, entry]));
const newById = new Map(after.cases.map((entry) => [entry.id, entry]));

const describeRun = (run) =>
  `${run.agentVersion} (${String(run.gitCommit).slice(0, 8)}${run.gitDirty ? ", uncommitted changes" : ""}), ${run.date}, repeat ${run.repeat}`;
console.log(`Old: ${describeRun(before)}`);
console.log(`New: ${describeRun(after)}`);
console.log(`Model: ${after.model}\n`);

const mismatches = findMismatches(before, after, oldById, newById);
if (mismatches.length > 0) {
  console.log("These two runs cannot be compared:");
  for (const problem of mismatches) console.log(`  ${problem}`);
  process.exit(2);
}
if (before.repeat !== after.repeat) {
  console.log("Note: the runs used different repeat counts, so their noise levels differ.\n");
}

const pairs = [...oldById.values()].map((entry) => ({ before: entry, after: newById.get(entry.id) }));
const notRun = pairs.filter((pair) => pair.before.status === "not_run" || pair.after.status === "not_run");
const graded = pairs.filter((pair) => pair.before.status !== "not_run" && pair.after.status !== "not_run");
const regressions = graded.filter((pair) => pair.before.status === "passed" && pair.after.status === "failed");
const improvements = graded.filter((pair) => pair.before.status === "failed" && pair.after.status === "passed");

if (regressions.length === 0) {
  console.log("No case went from passing to failing.");
} else {
  console.log(`Got worse (${regressions.length}):`);
  for (const pair of regressions) {
    console.log(`  ${pair.after.id}: passed before, fails now (${votes(pair.before)}, now ${votes(pair.after)})`);
    if (pair.after.failReasons.length > 0) {
      console.log(`    ${pair.after.failReasons.join("; ").slice(0, 200)}`);
    }
  }
}
if (improvements.length > 0) {
  console.log(`\nGot better (${improvements.length}):`);
  for (const pair of improvements) console.log(`  ${pair.after.id}`);
}

const oldPasses = graded.filter((pair) => pair.before.status === "passed").length;
const newPasses = graded.filter((pair) => pair.after.status === "passed").length;
const drop = oldPasses - newPasses;
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const whole = (value) => String(Math.round(value));

console.log(`\nPassed: ${oldPasses} -> ${newPasses} of ${graded.length} cases`);
console.log(`Median time per case:   ${describeChange(pairedMedians(graded, "durationMs"), seconds)}`);
console.log(`Median steps per case:  ${describeChange(pairedMedians(graded, "steps"), whole)}`);
console.log(`Median tokens per case: ${describeChange(pairedMedians(graded, "tokens"), whole)}`);

if (notRun.length > 0) {
  console.log(`\n${notRun.length} case(s) did not run in at least one of the runs and were left out:`);
  for (const pair of notRun) {
    console.log(`  ${pair.after.id}: ${pair.after.notRunReason ?? pair.before.notRunReason}`);
  }
}

console.log("");
if (drop > threshold) {
  console.log(`VERDICT: the agent got worse. Passes dropped by ${drop}, more than the allowed ${threshold}.`);
  process.exit(1);
}
if (notRun.length > 0) {
  console.log("VERDICT: inconclusive, because not every case ran. Fix the cause and run the exam again.");
  process.exit(2);
}
console.log(`VERDICT: OK. Passes changed by ${-drop}, within the allowed drop of ${threshold}.`);
