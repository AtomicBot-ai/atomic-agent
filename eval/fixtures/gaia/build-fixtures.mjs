#!/usr/bin/env node
// Generates the 5 GAIA-style fixtures (3 PDF + 2 XLSX) into this folder.
// Idempotent — overwrites existing files. Run once after schema bumps:
//
//   node eval/fixtures/gaia/build-fixtures.mjs
//
// Fixtures intentionally use libraries that match the production
// extractors (pdfkit -> pdfjs-dist; exceljs -> exceljs) so the agent
// sees the same text shape we ship in `os.fs.read_document`.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";

const HERE = dirname(fileURLToPath(import.meta.url));

async function buildPdf(filename, build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => {
      writeFileSync(join(HERE, filename), Buffer.concat(chunks));
      resolve();
    });
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

async function buildXlsx(filename, build) {
  const wb = new ExcelJS.Workbook();
  await build(wb);
  await wb.xlsx.writeFile(join(HERE, filename));
}

// PDF #1 — quarterly-report.pdf : single-page financial table.
// Question target: "Q3 revenue?" → 8.4
await buildPdf("quarterly-report.pdf", (doc) => {
  doc.fontSize(18).text("Acme Corp — Quarterly Revenue 2024", { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(
    "All figures in millions USD. Reviewed by the audit committee on 2024-12-15.",
  );
  doc.moveDown();
  doc.fontSize(14).text("Revenue by quarter:");
  doc.moveDown(0.5);
  doc.fontSize(12);
  const rows = [
    ["Quarter", "Revenue", "YoY Growth"],
    ["Q1", "6.2", "+4%"],
    ["Q2", "7.1", "+9%"],
    ["Q3", "8.4", "+18%"],
    ["Q4", "9.0", "+12%"],
  ];
  for (const r of rows) {
    doc.text(r.join("    "));
  }
  doc.moveDown();
  doc.text(
    "The Q3 figure of 8.4 was driven primarily by the launch of the new enterprise tier in July.",
  );
});

// PDF #2 — policy-handbook.pdf : multi-page document, fact on page 3.
// Question target: "vacation days for tenure > 5 years?" → 21
await buildPdf("policy-handbook.pdf", (doc) => {
  doc.fontSize(20).text("Employee Policy Handbook", { align: "center" });
  doc.moveDown(2);
  doc.fontSize(12).text(
    "This handbook describes the standing policies of Acme Corp. Each section addresses a distinct topic; consult the relevant section before contacting HR.",
  );
  doc.addPage();
  doc.fontSize(16).text("Section 2 — Working Hours");
  doc.moveDown();
  doc.fontSize(12).text(
    "Standard working hours are 09:00–18:00 with a one-hour lunch break. Flexible arrangements may be requested through your line manager.",
  );
  doc.addPage();
  doc.fontSize(16).text("Section 3 — Paid Leave");
  doc.moveDown();
  doc.fontSize(12).text(
    "Annual paid leave is granted on a tenure-based scale. The schedule is as follows:",
  );
  doc.moveDown(0.5);
  doc.text("- Less than 1 year of service: 14 working days per year.");
  doc.text("- 1 to 3 years of service: 16 working days per year.");
  doc.text("- 3 to 5 years of service: 18 working days per year.");
  doc.text("- More than 5 years of service: 21 working days per year.");
  doc.moveDown();
  doc.text(
    "Unused leave does not roll over beyond December 31 of the following year.",
  );
  doc.addPage();
  doc.fontSize(16).text("Section 4 — Remote Work");
  doc.moveDown();
  doc.fontSize(12).text(
    "Up to 2 days per week of remote work are permitted with manager approval.",
  );
});

// PDF #3 — budget-2023.pdf — base figure used in cross-doc reasoning.
// Pairs with budget-revision-2024.pdf below.
await buildPdf("budget-2023.pdf", (doc) => {
  doc.fontSize(18).text("Engineering Budget — Fiscal Year 2023");
  doc.moveDown();
  doc.fontSize(12).text(
    "The board approved an engineering budget of 100,000 USD for fiscal year 2023, distributed across hiring, infrastructure, and tooling.",
  );
  doc.moveDown();
  doc.text("Total approved: 100000 USD.");
  doc.moveDown();
  doc.text(
    "Any revision for fiscal 2024 will be issued as a separate addendum (see budget-revision-2024.pdf).",
  );
});

// PDF #4 (companion to #3) — budget-revision-2024.pdf : multi-doc reasoning.
// Question target: "2024 budget after revision?" → 115000 (100000 * 1.15)
await buildPdf("budget-revision-2024.pdf", (doc) => {
  doc.fontSize(18).text("Engineering Budget — Revision for FY 2024");
  doc.moveDown();
  doc.fontSize(12).text(
    "Revising the prior-year baseline from budget-2023.pdf, the board has approved a 15% increase to the engineering budget for fiscal year 2024.",
  );
  doc.moveDown();
  doc.text(
    "The revised total is computed as last year's approved amount multiplied by 1.15.",
  );
  doc.moveDown();
  doc.text(
    "All figures take effect on January 1, 2024. Quarterly review meetings will track variance against the revised total.",
  );
});

// XLSX #1 — transactions.xlsx : conditional aggregation (GAIA Level 2).
// Question target: "sum of subscription revenue in Jan 2024?" → 4500
//   3 subscription rows in Jan: 1500 + 1500 + 1500 = 4500. Other rows
//   are noise (different category or different month) and MUST be
//   excluded for the answer to be correct.
await buildXlsx("transactions.xlsx", async (wb) => {
  const ws = wb.addWorksheet("Transactions");
  ws.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Category", key: "category", width: 18 },
    { header: "Amount", key: "amount", width: 12 },
    { header: "Customer", key: "customer", width: 20 },
  ];
  const rows = [
    ["2024-01-04", "subscription", 1500, "Globex"],
    ["2024-01-09", "consulting", 8000, "Initech"],
    ["2024-01-15", "subscription", 1500, "Umbrella"],
    ["2024-01-21", "support", 600, "Hooli"],
    ["2024-01-28", "subscription", 1500, "Stark Industries"],
    ["2024-02-03", "subscription", 1500, "Wayne Enterprises"],
    ["2024-02-12", "consulting", 9000, "Cyberdyne"],
    ["2024-02-19", "subscription", 1500, "Globex"],
    ["2024-02-25", "support", 800, "Initech"],
    ["2024-03-04", "subscription", 1500, "Umbrella"],
    ["2024-03-11", "subscription", 1500, "Hooli"],
    ["2024-03-22", "support", 700, "Stark Industries"],
  ];
  for (const r of rows) {
    ws.addRow({ date: r[0], category: r[1], amount: r[2], customer: r[3] });
  }
});

// XLSX #2 — inventory.xlsx : count-distinct over a column.
// Question target: "How many distinct manufacturers in inventory.xlsx?"
//   Distinct manufacturers = {Acme, Globex, Initech, Umbrella, Stark} = 5.
//   The "QA — Notes" sheet exists to test that the agent picks the
//   right sheet (NOT to be counted as inventory data).
await buildXlsx("inventory.xlsx", async (wb) => {
  const inv = wb.addWorksheet("Inventory");
  inv.columns = [
    { header: "SKU", key: "sku", width: 10 },
    { header: "Item", key: "item", width: 20 },
    { header: "Manufacturer", key: "mfg", width: 18 },
    { header: "QtyInStock", key: "qty", width: 12 },
  ];
  const rows = [
    ["A001", "Widget alpha", "Acme", 120],
    ["A002", "Widget beta", "Acme", 80],
    ["G003", "Gizmo X", "Globex", 200],
    ["G004", "Gizmo Y", "Globex", 50],
    ["I005", "Sprocket", "Initech", 30],
    ["U006", "Bracket", "Umbrella", 75],
    ["U007", "Mount", "Umbrella", 40],
    ["S008", "Reactor core", "Stark", 5],
    ["S009", "Repulsor coil", "Stark", 15],
    ["A010", "Widget gamma", "Acme", 110],
  ];
  for (const r of rows) {
    inv.addRow({ sku: r[0], item: r[1], mfg: r[2], qty: r[3] });
  }
  const notes = wb.addWorksheet("QA — Notes");
  notes.addRow(["Last audit: 2024-04-01"]);
  notes.addRow(["Auditor: J. Smith"]);
  notes.addRow(["Manufacturers list is normalised — exact spelling matters."]);
});

console.log("✓ wrote 5 fixtures to", HERE);
