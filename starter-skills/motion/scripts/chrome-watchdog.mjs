#!/usr/bin/env node
// Started by render-frames.mjs next to headless Chrome:
//   node chrome-watchdog.mjs <render pid> <chrome pid> [temp dir...]
// Checks once a second; if the render script is gone but Chrome is still
// running (the script was killed with no chance to clean up), kills Chrome
// and removes the temp folders. Exits once Chrome has stopped while the
// render script is still running (the normal end).

import { rmSync } from "node:fs";

const [parentArg, chromeArg, ...dirs] = process.argv.slice(2);
const parentPid = Number(parentArg);
const chromePid = Number(chromeArg);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

if (Number.isInteger(parentPid) && Number.isInteger(chromePid)) {
  const timer = setInterval(() => {
    // Normal end: the render script stopped Chrome and cleaned up itself.
    if (!alive(chromePid) && alive(parentPid)) {
      clearInterval(timer);
      return;
    }
    if (!alive(parentPid)) {
      try {
        process.kill(chromePid, "SIGKILL");
      } catch {
        // already gone
      }
      clearInterval(timer);
      setTimeout(() => {
        for (const dir of dirs) {
          if (!/motion-(chrome|frames)-/.test(dir)) continue;
          try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          } catch {
            // a leftover temp folder is harmless
          }
        }
      }, 1000);
    }
  }, 1000);
}
