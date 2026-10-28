import { describe, expect, it } from "vitest";
import {
  STREAM_LOOP_MIN_REPEATS,
  createStreamRepetitionWatcher,
} from "./stream-repetition-watcher.js";

/** Feed `text` in token-sized pieces; the first loop reported, or null. */
function watch(text: string, channel: "content" | "reasoning" = "content") {
  const watcher = createStreamRepetitionWatcher();
  for (let i = 0; i < text.length; i += 4) {
    const piece = text.slice(i, i + 4);
    const hit =
      channel === "content"
        ? watcher.push(piece, "")
        : watcher.push("", piece);
    if (hit !== null) return { ...hit, at: i + piece.length };
  }
  return null;
}

describe("createStreamRepetitionWatcher", () => {
  it("catches a short block looping after a normal start, within a few hundred characters", () => {
    const hit = watch(`Key principles: use direct verbs ${'}]"}]'.repeat(400)}`);
    expect(hit).toMatchObject({ channel: "content", periodChars: 5 });
    expect(hit!.at).toBeLessThan(400);
  });

  it("catches a code block repeated ten times", () => {
    const block = [
      "function renderRow(row) {",
      "  const cell = document.createElement('td');",
      "  cell.textContent = row.value;",
      "  return cell;",
      "}",
      "",
    ].join("\n");
    expect(block.length).toBeGreaterThan(64);
    const hit = watch(`// table\n${block.repeat(10)}`);
    expect(hit?.periodChars).toBe(block.length);
  });

  it("catches a loop in the reasoning channel", () => {
    const line = "Wait, let me check the file again. ";
    expect(watch(line.repeat(30), "reasoning")).toMatchObject({
      channel: "reasoning",
      periodChars: line.length,
    });
  });

  it("waits for eight copies of a long block", () => {
    const block = `${"x".repeat(60)}${"0123456789".repeat(4)}\n`;
    expect(block.length).toBe(101);
    expect(watch(block.repeat(STREAM_LOOP_MIN_REPEATS - 2))).toBeNull();
    expect(watch(block.repeat(STREAM_LOOP_MIN_REPEATS + 1))).not.toBeNull();
  });

  it("does not cut a 200-row Markdown table", () => {
    const table = [
      "| id | name | score |",
      "|----|------|-------|",
      ...Array.from(
        { length: 200 },
        (_, i) => `| ${i} | user${i} | ${(i * 37) % 101} |`,
      ),
    ].join("\n");
    expect(watch(table)).toBeNull();
  });

  it("does not cut a JSON array of same-shaped objects", () => {
    const items = Array.from({ length: 150 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      done: i % 3 === 0,
    }));
    expect(watch(JSON.stringify(items, null, 2))).toBeNull();
  });

  it("does not cut CSV rows or an ordinary long source file", () => {
    const csv = Array.from(
      { length: 300 },
      (_, i) => `${i},2026-10-${(i % 28) + 1},${(i * 13) % 97}.5`,
    ).join("\n");
    expect(watch(csv)).toBeNull();
    const source = Array.from(
      { length: 120 },
      (_, i) =>
        `export function handler${i}(input: number): number {\n  return input * ${i + 2};\n}\n`,
    ).join("\n");
    expect(watch(source)).toBeNull();
  });
});
