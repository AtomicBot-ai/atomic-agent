// Skill Lab check for xlsx: sales.xlsx has a sheet named Sales with the
// header, the three rows and a SUM formula over B2:B4 in B5.
import { readZip } from "./zip.mjs";

let zip;
try {
  zip = readZip("sales.xlsx");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const text = (name) => zip.get(name)?.toString("utf8") ?? "";
const problems = [];
if (!/<sheet [^>]*name="Sales"/.test(text("xl/workbook.xml"))) problems.push('no sheet named "Sales"');
const sheets = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).map(text).join("\n");
const strings = text("xl/sharedStrings.xml") + sheets;
for (const word of ["Region", "Total", "North", "South", "East"]) if (!strings.includes(word)) problems.push(`missing ${word}`);
for (const n of ["120", "80", "50"]) if (!new RegExp(`<v>${n}(\\.0)?</v>`).test(sheets)) problems.push(`missing value ${n}`);
if (!/<c [^>]*r="B5"[^>]*>\s*<f>\s*=?SUM\(B2:B4\)\s*<\/f>/i.test(sheets)) problems.push("B5 is not =SUM(B2:B4)");
if (problems.length > 0) {
  console.error(problems.join("; "));
  process.exit(1);
}
