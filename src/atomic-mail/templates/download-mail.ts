import type { DownloadJob } from "../../local-llm/index.js";
import { SCREEN, esc, renderBar, renderMailShell } from "./mail-shell.js";

/**
 * The "your model landed" mail — and its two unhappy siblings. Pure:
 * a job record in, `{subject, text, html}` out. The HTML is the CRT
 * shell; the plain-text twin carries every fact the HTML does, so a
 * text-only client (or a watch face) loses nothing but the sprites.
 */
export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export interface DownloadMailInput {
  job: DownloadJob;
  /** The agent's own address, for the footer. */
  from: string;
  /** Test seam: fixed clock for the duration line. */
  now?: Date;
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function modelName(job: DownloadJob): string {
  return job.label.replace(/\s*\((gguf|mmproj)\)\s*$/i, "");
}

/** `0x1A2B` from the job id — a transmission number that stays put across resends. */
function transmissionCode(job: DownloadJob): string {
  let h = 0;
  for (const ch of job.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `0x${(h % 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

function quant(job: DownloadJob): string | null {
  // "Qwen3.8-27B-Uncensored-noMTP-Q4_K_M.gguf" → Q4_K_M; label-only guess.
  const m = /\b(Q\d[A-Z0-9_]*|IQ\d[A-Z0-9_]*|F16|BF16|F32)\b/i.exec(job.label);
  return m ? m[1]!.toUpperCase() : null;
}

export function renderDownloadMail(input: DownloadMailInput): RenderedMail {
  const { job } = input;
  const name = modelName(job);
  const total = job.totalBytes > 0 ? job.totalBytes : job.transferredBytes;
  const started = Date.parse(job.startedAt);
  const finished = Date.parse(job.finishedAt ?? "") || (input.now ?? new Date()).getTime();
  const took = formatDuration(finished - started);
  const q = quant(job);
  const what = job.phase === "mmproj" ? "VISION PROJECTOR" : "MODEL";
  const factsLine = [formatBytes(total), q, took !== "—" ? took : null].filter(Boolean).join(" · ");

  if (job.status === "done") {
    const subject = `▶ ${what} READY: ${name}`;
    const text = [
      `ATOMIC AGENT — TRANSMISSION ${transmissionCode(job)}`,
      "",
      `${what} READY`,
      `> ${name}`,
      `> ${factsLine}`,
      "> landed in your models folder",
      `> [${"█".repeat(24)}] 100%`,
      "",
      "ADDITIONAL WEIGHTS ACQUIRED · RESEARCH COMPLETE",
      "",
      "▶ PRESS START — open Atomic Agent, the model is ready to use.",
      "",
      `sent by ${input.from} · reply to talk to your agent`,
    ].join("\n");
    const html = renderMailShell({
      transmission: `TRANSMISSION ${transmissionCode(job)}`,
      banner: what === "MODEL" ? "MODEL READY" : "VISION READY",
      bannerColor: SCREEN.green,
      readout: [
        `<span style="color:${SCREEN.green}">&gt;</span> ${esc(name)}`,
        `<span style="color:${SCREEN.green}">&gt;</span> ${esc(factsLine)}`,
        `<span style="color:${SCREEN.green}">&gt;</span> landed in your models folder`,
        `<span style="color:${SCREEN.green}">&gt;</span> ${renderBar(100, SCREEN.green)}`,
      ],
      status: "ADDITIONAL WEIGHTS ACQUIRED · RESEARCH COMPLETE",
      cta: "PRESS START — open Atomic Agent, the model is ready to use.",
      from: input.from,
      title: `${what === "MODEL" ? "Model" : "Vision projector"} ready: ${name}`,
    });
    return { subject, text, html };
  }

  const reason = job.error ?? "unknown error";
  const percent = total > 0 ? Math.round((job.transferredBytes / total) * 100) : 0;
  if (job.resumable) {
    const kept =
      job.transferredBytes > 0
        ? `${formatBytes(job.transferredBytes)} of ${formatBytes(total)} kept on disk`
        : "nothing downloaded yet";
    const subject = `⏸ TRANSMISSION LOST: ${name} (${percent}%)`;
    const text = [
      `ATOMIC AGENT — TRANSMISSION ${transmissionCode(job)}`,
      "",
      "TRANSMISSION LOST",
      `> ${name}`,
      `> ${reason}`,
      `> ${kept}`,
      `> [${"█".repeat(Math.round(percent / 100 * 24))}${"░".repeat(24 - Math.round(percent / 100 * 24))}] ${percent}%`,
      "",
      "NOT ENOUGH BANDWIDTH · THE PARTIAL WAITS",
      "",
      "▶ PRESS START — relaunch Atomic Agent and the download resumes by itself.",
      "",
      `sent by ${input.from} · reply to talk to your agent`,
    ].join("\n");
    const html = renderMailShell({
      transmission: `TRANSMISSION ${transmissionCode(job)}`,
      banner: "SIGNAL LOST",
      bannerColor: SCREEN.amber,
      readout: [
        `<span style="color:${SCREEN.amber}">&gt;</span> ${esc(name)}`,
        `<span style="color:${SCREEN.amber}">&gt;</span> ${esc(reason)}`,
        `<span style="color:${SCREEN.amber}">&gt;</span> ${esc(kept)}`,
        `<span style="color:${SCREEN.amber}">&gt;</span> ${renderBar(percent, SCREEN.amber)}`,
      ],
      status: "NOT ENOUGH BANDWIDTH · THE PARTIAL WAITS",
      cta: "PRESS START — relaunch Atomic Agent and the download resumes by itself.",
      from: input.from,
      title: `Download paused: ${name}`,
    });
    return { subject, text, html };
  }

  const subject = `✕ DOWNLOAD FAILED: ${name}`;
  const text = [
    `ATOMIC AGENT — TRANSMISSION ${transmissionCode(job)}`,
    "",
    "DOWNLOAD FAILED",
    `> ${name}`,
    `> ${reason}`,
    `> [${"█".repeat(Math.round(percent / 100 * 24))}${"░".repeat(24 - Math.round(percent / 100 * 24))}] ${percent}%`,
    "",
    "MISSION ABORTED · THE FILE, NOT THE LINK",
    "",
    "▶ PRESS START — open Atomic Agent → Models to try again or pick another build.",
    "",
    `sent by ${input.from} · reply to talk to your agent`,
  ].join("\n");
  const html = renderMailShell({
    transmission: `TRANSMISSION ${transmissionCode(job)}`,
    banner: "GAME OVER",
    bannerColor: SCREEN.red,
    readout: [
      `<span style="color:${SCREEN.red}">&gt;</span> ${esc(name)}`,
      `<span style="color:${SCREEN.red}">&gt;</span> ${esc(reason)}`,
      `<span style="color:${SCREEN.red}">&gt;</span> ${renderBar(percent, SCREEN.red)}`,
    ],
    status: "MISSION ABORTED · THE FILE, NOT THE LINK",
    statusColor: SCREEN.red,
    cta: "PRESS START — open Atomic Agent → Models to try again or pick another build.",
    from: input.from,
    title: `Download failed: ${name}`,
  });
  return { subject, text, html };
}
