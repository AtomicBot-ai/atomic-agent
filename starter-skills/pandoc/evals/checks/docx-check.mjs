// Skill Lab check for pandoc: notes.docx is a Word file whose text has the
// title as a heading, the bullet items and the table.
import { readZip } from "./zip.mjs";

let doc;
try {
  doc = readZip("notes.docx").get("word/document.xml")?.toString("utf8") ?? "";
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const text = doc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const problems = [];
for (const s of ["Quarterly plan", "Faster sync on slow networks", "A new export screen", "Mira", "Export screen"]) {
  if (!text.includes(s)) problems.push(`missing text: ${s}`);
}
if (!/<w:pStyle w:val="(Heading1|Title)"/.test(doc)) problems.push("title is not a heading");
if (!/<w:tbl>/.test(doc)) problems.push("table missing");
if (problems.length > 0) {
  console.error(problems.join("; "));
  process.exit(1);
}
