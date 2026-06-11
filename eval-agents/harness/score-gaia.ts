/**
 * Official GAIA leaderboard scorer (gaia-benchmark/leaderboard scorer.py)
 * ported to TypeScript for deterministic exact-match grading.
 */

export function normalizeNumberStr(numberStr: string): number {
  let s = numberStr;
  for (const ch of ["$", "%", ","]) {
    s = s.split(ch).join("");
  }
  const n = Number.parseFloat(s.trim());
  if (Number.isNaN(n)) return Number.POSITIVE_INFINITY;
  return n;
}

export function splitString(
  s: string,
  charList: string[] = [",", ";"],
): string[] {
  const pattern = new RegExp(`[${charList.map((c) => escapeRegExp(c)).join("")}]`);
  return s.split(pattern).map((part) => part.trim()).filter((part) => part.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFloatString(element: string): boolean {
  const n = Number.parseFloat(element);
  return !Number.isNaN(n) && Number.isFinite(n) && element.trim().length > 0;
}

export function normalizeStr(inputStr: string, removePunct = true): string {
  const noSpaces = inputStr.replace(/\s/g, "");
  const lower = noSpaces.toLowerCase();
  if (!removePunct) return lower;
  return lower.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "");
}

export function questionScorer(modelAnswer: string | null, groundTruth: string): boolean {
  const ma = modelAnswer ?? "None";
  const gt = groundTruth;

  if (isFloatString(gt)) {
    return normalizeNumberStr(ma) === Number.parseFloat(gt);
  }

  if ([",", ";"].some((ch) => gt.includes(ch))) {
    const gtElems = splitString(gt);
    const maElems = splitString(ma);
    if (gtElems.length !== maElems.length) return false;

    return gtElems.every((gtElem, i) => {
      const maElem = maElems[i] ?? "";
      if (isFloatString(gtElem)) {
        return normalizeNumberStr(maElem) === Number.parseFloat(gtElem);
      }
      return (
        normalizeStr(maElem, false) === normalizeStr(gtElem, false)
      );
    });
  }

  return normalizeStr(ma) === normalizeStr(gt);
}
