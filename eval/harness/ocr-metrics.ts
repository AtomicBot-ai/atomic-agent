/**
 * Text accuracy for the OCR benchmark (ATO-2502): character and word
 * error rates against a hand-checked transcript, the measures OCR
 * evaluations report (ISRI, ICDAR). Lower is better; 0 is a perfect read,
 * and a read that adds text can go above 1.
 *
 * Both sides are normalised first, so layout noise does not count as an
 * error: Unicode NFC, `ё` kept as is, runs of whitespace (line breaks,
 * tabs, the `--- page N ---` dividers removed) collapsed to one space,
 * and soft hyphens dropped. Case and punctuation are kept: a wrong
 * letter case is a real OCR error for search.
 */

export function normaliseOcrText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/^--- page \d+ ---$/gm, " ")
    .replace(/­/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Edit distance (insert, delete, substitute) between two sequences. */
export function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ai === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

export interface OcrAccuracy {
  /** Character error rate: edits / reference characters. */
  cer: number;
  /** Word error rate: edits over words / reference words. */
  wer: number;
  referenceChars: number;
  referenceWords: number;
}

export function ocrAccuracy(reference: string, recognised: string): OcrAccuracy {
  const ref = normaliseOcrText(reference);
  const hyp = normaliseOcrText(recognised);
  const refChars = Array.from(ref);
  const hypChars = Array.from(hyp);
  const refWords = ref === "" ? [] : ref.split(" ");
  const hypWords = hyp === "" ? [] : hyp.split(" ");
  return {
    cer: rate(editDistance(refChars, hypChars), refChars.length),
    wer: rate(editDistance(refWords, hypWords), refWords.length),
    referenceChars: refChars.length,
    referenceWords: refWords.length,
  };
}

function rate(edits: number, total: number): number {
  if (total === 0) return edits === 0 ? 0 : 1;
  return edits / total;
}

export interface OcrBenchRow {
  file: string;
  engine: string;
  pages: number;
  ocrPages: number;
  seconds: number;
  cer: number | null;
  wer: number | null;
  /** Set when the file was not read: the skip reason or the error. */
  error?: string;
}

export interface OcrEngineSummary {
  engine: string;
  files: number;
  failed: number;
  pages: number;
  secondsPerPage: number | null;
  /** Mean over the files that were read, each file weighted by its reference length. */
  cer: number | null;
  wer: number | null;
}

/**
 * One line per engine. Error rates are weighted by reference length
 * (micro-average), so a one-line page does not count as much as a dense
 * contract page. A file that failed is counted in `failed`, not averaged.
 */
export function summariseOcrBench(rows: readonly OcrBenchRow[], refLengths: ReadonlyMap<string, { chars: number; words: number }>): OcrEngineSummary[] {
  const engines = [...new Set(rows.map((row) => row.engine))];
  return engines.map((engine) => {
    const mine = rows.filter((row) => row.engine === engine);
    const read = mine.filter((row) => row.error === undefined && row.cer !== null && row.wer !== null);
    let chars = 0;
    let words = 0;
    let charEdits = 0;
    let wordEdits = 0;
    for (const row of read) {
      const ref = refLengths.get(row.file) ?? { chars: 0, words: 0 };
      chars += ref.chars;
      words += ref.words;
      charEdits += row.cer! * ref.chars;
      wordEdits += row.wer! * ref.words;
    }
    const pages = read.reduce((sum, row) => sum + row.ocrPages, 0);
    const seconds = read.reduce((sum, row) => sum + row.seconds, 0);
    return {
      engine,
      files: mine.length,
      failed: mine.length - read.length,
      pages,
      secondsPerPage: pages > 0 ? seconds / pages : null,
      cer: chars > 0 ? charEdits / chars : null,
      wer: words > 0 ? wordEdits / words : null,
    };
  });
}

/** The summary as a Markdown table for the procedure document. */
export function ocrBenchMarkdown(summary: readonly OcrEngineSummary[]): string {
  const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const sec = (value: number | null) => (value === null ? "n/a" : value.toFixed(2));
  const lines = [
    "| Engine | Files | Failed | Pages read | CER | WER | Seconds per page |",
    "|---|---|---|---|---|---|---|",
    ...summary.map((s) => `| ${s.engine} | ${s.files} | ${s.failed} | ${s.pages} | ${pct(s.cer)} | ${pct(s.wer)} | ${sec(s.secondsPerPage)} |`),
  ];
  return `${lines.join("\n")}\n`;
}
