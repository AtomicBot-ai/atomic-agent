import fs from "node:fs";

const reportDir = process.argv[2];
const metaPath =
  "eval-agents/datasets/gaia/hf/2023/validation/metadata.jsonl";

const meta = fs
  .readFileSync(metaPath, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const gold = {};
for (const m of meta)
  gold[m.task_id] = {
    ans: m["Final answer"],
    file: m.file_name || "",
    q: m.Question,
  };

const rows = fs
  .readFileSync(`${reportDir}/matrix.jsonl`, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const fails = rows.filter((r) => !r.result.correct && !r.result.skipped);

const refuseRe =
  /^(.{0,90})(cannot|unable|apologi|please confirm|sorry|don.t have access|stopped:)/i;

for (const r of fails) {
  const res = r.result;
  const g = gold[res.taskId] || {};
  const m = res.metrics || {};
  const ext = (g.file.split(".").pop() || "").toLowerCase();
  const ftype = g.file
    ? ["mp3", "wav"].includes(ext)
      ? "AUDIO"
      : ["png", "jpg", "jpeg"].includes(ext)
        ? "IMG"
        : ["xlsx", "csv"].includes(ext)
          ? "SHEET"
          : ["docx", "pdf", "pptx"].includes(ext)
            ? "DOC"
            : ext.toUpperCase()
    : "-";
  const reply = res.rawReply || "";
  const refuse = refuseRe.test(reply) ? "REFUSE/STOP" : "";
  const steps = String(m.steps ?? "?").padStart(2);
  const tok = String(Math.round((m.totalTokens || 0) / 1000) + "k").padStart(6);
  console.log(
    `${res.taskId.slice(0, 8)} | ${String(ftype).padEnd(6)}| st=${steps} tok=${tok} | ${refuse.padEnd(10)} | gold="${String(g.ans).slice(0, 24)}" -> "${(res.extractedAnswer || "").slice(0, 24)}"`,
  );
}
