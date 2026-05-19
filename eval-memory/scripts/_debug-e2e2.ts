import { runE2E2 } from "../experiments/e2e-2-lesson-application/runner.js";

const stateDir = process.env.STATE_DIR ?? "/tmp/e2e2-keep/state";
const r = await runE2E2({
  llamaUrl: "http://127.0.0.1:19091",
  stateDir,
});
console.log("=== REPORT ===");
console.log(JSON.stringify(r, null, 2));
console.log(`\n=== state preserved at ${stateDir} ===`);
