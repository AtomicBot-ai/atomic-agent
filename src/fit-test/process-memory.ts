/**
 * Resident memory of a process, for the fit-test's peak-memory column
 * (ATO-1090). `ps -o rss=` on macOS and Linux; `null` elsewhere and on
 * any failure, which the table shows as "n/a". On Apple silicon the
 * model's weights live in unified memory and count toward this number.
 */
import { execFile } from "node:child_process";

export function readProcessRssBytes(pid: number): Promise<number | null> {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const kib = Number.parseInt(String(stdout).trim(), 10);
      resolve(Number.isFinite(kib) && kib > 0 ? kib * 1024 : null);
    });
  });
}
