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

// XLSX #1 — transactions.xlsx : conditional aggregation (GAIA Level 2)
// AND top-N ranking (gaia-xlsx-top-3-customers).
// Question targets:
//   - "sum of subscription revenue in Jan 2024?" → 4500
//     3 subscription rows in Jan: 1500 + 1500 + 1500 = 4500. Other rows
//     are noise (different category or different month) and MUST be
//     excluded for the answer to be correct.
//   - "top-3 customers by total amount, desc, comma-separated?"
//     → Cyberdyne, Initech, Globex
//     Totals after the April top-up rows (load-bearing for the tie
//     break — without them Globex and Umbrella both sit at 3000):
//       Cyberdyne = 9000 + 3000  = 12000
//       Initech   = 8000 + 800 + 1500 = 10300
//       Globex    = 1500 + 1500 + 2000 = 5000
//       Umbrella  = 1500 + 1500       = 3000
//       Stark     = 1500 + 700        = 2200
//       Hooli     = 600 + 1500        = 2100
//       Wayne     = 1500              = 1500
//     The April rows DO NOT change the Jan-subscription sum (4500),
//     so the existing conditional-sum case stays green.
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
    // April top-ups for top-N: shift Cyberdyne, Initech, Globex
    // above the 3000 tie zone occupied by Globex/Umbrella in Q1.
    ["2024-04-05", "subscription", 2000, "Globex"],
    ["2024-04-15", "consulting", 3000, "Cyberdyne"],
    ["2024-04-20", "subscription", 1500, "Initech"],
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

// PDF #5 — org-chart.pdf : disambiguation across same-surname candidates.
// Question target: "Full name of the head of Engineering with surname
// Smith?" → "Alice Smith".
//
// The dispractor "Bob Smith" appears FIRST in the document and is the
// VP of Marketing, so a naive "find the first Smith" strategy yields
// the wrong answer. The agent must filter by department.
//
// Additional noise: a second Engineering manager (Carol Lee, no Smith
// surname) and a Smith elsewhere in the org appear too, to discourage
// "pick any Smith with `Engineering` nearby" shortcuts.
await buildPdf("org-chart.pdf", (doc) => {
  doc.fontSize(20).text("Acme Corp — Organisation Chart 2024", {
    align: "center",
  });
  doc.moveDown(2);
  doc.fontSize(12).text(
    "This chart lists the leadership of each division. Names are formatted as `First Last`. Each division reports to the CEO.",
  );
  doc.moveDown(2);

  doc.fontSize(16).text("Marketing");
  doc.moveDown(0.5);
  doc.fontSize(12);
  doc.text("- VP, Marketing: Bob Smith");
  doc.text("- Marketing Director: Diana Park");
  doc.text("- Brand Lead: Evan Patel");
  doc.moveDown();

  doc.fontSize(16).text("Finance");
  doc.moveDown(0.5);
  doc.fontSize(12);
  doc.text("- VP, Finance: Carol Smith");
  doc.text("- Controller: Frank Liu");
  doc.text("- Treasury Manager: Grace Okoye");
  doc.moveDown();

  doc.fontSize(16).text("Engineering");
  doc.moveDown(0.5);
  doc.fontSize(12);
  doc.text("- VP, Engineering: Alice Smith");
  doc.text("- Director of Platform: Carol Lee");
  doc.text("- Director of Infrastructure: Hiro Tanaka");
  doc.text("- Director of Mobile: Ivy Chen");
  doc.moveDown();

  doc.fontSize(16).text("Operations");
  doc.moveDown(0.5);
  doc.fontSize(12);
  doc.text("- VP, Operations: Jamal Reed");
  doc.text("- Facilities Manager: Kara Novak");
  doc.text("- Logistics Lead: Luis Romero");
  doc.moveDown(2);

  doc.text(
    "For role changes, contact the People Operations team. The chart is reviewed every six months.",
  );
});

// PDF #6 — compliance-handbook.pdf : long-context "needle in haystack".
// Question target: "dollar threshold above which air travel requires CFO
// approval?" → 2500. The needle sits in Section 4 ("Travel Reimbursement"
// — Exceptions) on page 8 of 12. All other monetary figures across the
// document (salary 75000, allowance 1500, severance 50000, etc.) are
// intentionally distinct from 2500 so a grep-only strategy fails.
await buildPdf("compliance-handbook.pdf", (doc) => {
  // Page 1 — cover + TOC.
  doc.fontSize(22).text("Acme Corp Compliance Handbook 2024", {
    align: "center",
  });
  doc.moveDown(2);
  doc.fontSize(14).text("Table of Contents", { align: "center" });
  doc.moveDown();
  doc.fontSize(12);
  doc.text("Section 1 — Onboarding");
  doc.text("Section 2 — Compensation");
  doc.text("Section 3 — Paid Leave");
  doc.text("Section 4 — Travel Reimbursement");
  doc.text("Section 5 — Equipment Allowance");
  doc.text("Section 6 — Termination & Severance");

  // Section 1 — Onboarding (pages 2-3).
  doc.addPage();
  doc.fontSize(18).text("Section 1 — Onboarding");
  doc.moveDown();
  doc.fontSize(12).text(
    "All new hires must complete onboarding within their first ten business days. Onboarding includes IT setup, security training, and an introduction to company-wide compliance policies.",
  );
  doc.moveDown();
  doc.text(
    "Each new hire is paired with a buddy from a different team. Buddy assignments are tracked by People Operations and renewed every six months.",
  );
  doc.addPage();
  doc.fontSize(14).text("Section 1.1 — Required Training");
  doc.moveDown();
  doc.fontSize(12).text(
    "Mandatory training modules cover information security, anti-harassment policies, and data privacy. Completion is recorded in the LMS within thirty days of start date.",
  );

  // Section 2 — Compensation (pages 4-5).
  doc.addPage();
  doc.fontSize(18).text("Section 2 — Compensation");
  doc.moveDown();
  doc.fontSize(12).text(
    "Base salaries are reviewed annually in January. The starting salary for a junior engineer is 75000 USD per year, adjusted for cost-of-living differences across regions.",
  );
  doc.moveDown();
  doc.text(
    "Bonuses are discretionary and depend on individual and company performance.",
  );
  doc.addPage();
  doc.fontSize(14).text("Section 2.1 — Equity");
  doc.moveDown();
  doc.fontSize(12).text(
    "Employees may receive equity grants at hire and on promotion. Vesting follows a standard 4-year schedule with a 1-year cliff.",
  );

  // Section 3 — Paid Leave (pages 6-7).
  doc.addPage();
  doc.fontSize(18).text("Section 3 — Paid Leave");
  doc.moveDown();
  doc.fontSize(12).text(
    "Paid time off is granted annually and scales with tenure. See the employee policy handbook for the full tenure schedule.",
  );
  doc.addPage();
  doc.fontSize(14).text("Section 3.1 — Sick Leave");
  doc.moveDown();
  doc.fontSize(12).text(
    "Up to ten days per year of paid sick leave are granted to all full-time employees. Unused sick leave does not roll over.",
  );

  // Section 4 — Travel Reimbursement (page 8, THE needle is here).
  doc.addPage();
  doc.fontSize(18).text("Section 4 — Travel Reimbursement");
  doc.moveDown();
  doc.fontSize(12).text(
    "Business travel is reimbursed on a receipts-required basis. Submit an expense report within fourteen days of return. Per-diem meal allowance is 60 USD per day.",
  );
  doc.moveDown();
  doc.fontSize(14).text("Section 4.1 — Exceptions");
  doc.moveDown(0.5);
  doc.fontSize(12).text(
    "Air travel exceeding 2500 USD requires CFO approval before booking. This threshold applies to the total ticket price including taxes and fees; it does not apply to ground transportation or hotel costs.",
  );
  doc.moveDown();
  doc.text(
    "Any exception above the standard policy must be documented in the expense report.",
  );

  // Section 5 — Equipment Allowance (pages 9-10).
  doc.addPage();
  doc.fontSize(18).text("Section 5 — Equipment Allowance");
  doc.moveDown();
  doc.fontSize(12).text(
    "Each employee receives a 1500 USD equipment allowance on hire, renewable every three years. Approved purchases include laptops, monitors, and ergonomic accessories.",
  );
  doc.addPage();
  doc.fontSize(14).text("Section 5.1 — Software");
  doc.moveDown();
  doc.fontSize(12).text(
    "Site licenses for standard tooling (IDE, communication, productivity) are provided by IT and do not draw against the equipment allowance.",
  );

  // Section 6 — Termination & Severance (pages 11-12).
  doc.addPage();
  doc.fontSize(18).text("Section 6 — Termination & Severance");
  doc.moveDown();
  doc.fontSize(12).text(
    "Severance for involuntary termination is two weeks of base salary per year of service, with a cap of 50000 USD for employees below director level.",
  );
  doc.addPage();
  doc.fontSize(14).text("Section 6.1 — Exit Process");
  doc.moveDown();
  doc.fontSize(12).text(
    "All company property must be returned within five business days. Final pay is issued by direct deposit on the next regular pay cycle.",
  );
});

// XLSX #3 — orders-q4.xlsx : set-difference against inventory.xlsx.
// Question target: "Which manufacturer from inventory.xlsx has zero
// orders in orders-q4.xlsx?" → Initech.
//   Inventory has {Acme, Globex, Initech, Umbrella, Stark}. Orders-Q4
//   covers everyone EXCEPT Initech.
await buildXlsx("orders-q4.xlsx", async (wb) => {
  const ws = wb.addWorksheet("Q4Orders");
  ws.columns = [
    { header: "OrderId", key: "order_id", width: 12 },
    { header: "Date", key: "date", width: 14 },
    { header: "Manufacturer", key: "mfg", width: 18 },
    { header: "SKU", key: "sku", width: 10 },
    { header: "Qty", key: "qty", width: 8 },
  ];
  const rows = [
    ["O-1001", "2024-10-03", "Acme", "A001", 50],
    ["O-1002", "2024-10-12", "Globex", "G003", 30],
    ["O-1003", "2024-10-20", "Stark", "S008", 5],
    ["O-1004", "2024-11-04", "Umbrella", "U006", 20],
    ["O-1005", "2024-11-15", "Acme", "A002", 40],
    ["O-1006", "2024-11-21", "Globex", "G004", 15],
    ["O-1007", "2024-12-02", "Stark", "S009", 10],
    ["O-1008", "2024-12-12", "Umbrella", "U007", 12],
    ["O-1009", "2024-12-18", "Acme", "A010", 25],
    ["O-1010", "2024-12-28", "Globex", "G003", 18],
  ];
  for (const r of rows) {
    ws.addRow({
      order_id: r[0],
      date: r[1],
      mfg: r[2],
      sku: r[3],
      qty: r[4],
    });
  }
});

// PDF #7 — policy.pdf : auto-approve rule for cross-format join.
// Question target: "How many requests in requests.xlsx are
// auto-approved by this policy?" → 10. The rule is small enough to
// fit in one page so the agent can apply it precisely.
await buildPdf("policy.pdf", (doc) => {
  doc.fontSize(20).text("Procurement — Auto-Approval Policy", {
    align: "center",
  });
  doc.moveDown(2);
  doc.fontSize(12).text(
    "Purchase requests submitted through the procurement system are auto-approved when ALL of the following conditions are satisfied:",
  );
  doc.moveDown();
  doc.text("1. The request amount is strictly less than 5000 USD.");
  doc.text("2. The request category is NOT `consulting`.");
  doc.moveDown();
  doc.text(
    "Requests that fail either condition require manual review by the procurement team. The auto-approval thresholds are reviewed annually each November.",
  );
  doc.moveDown();
  doc.text(
    "The policy applies to standard purchase requests only. Special vehicles (e.g. travel, equipment refresh) are governed by separate rules in the compliance handbook.",
  );
});

// XLSX #4 — requests.xlsx : 20 rows of purchase requests; exactly 10
// auto-approve under policy.pdf (amount < 5000 AND category !=
// "consulting"). Auto-approved rows are interleaved with rejected
// rows to discourage row-position heuristics.
await buildXlsx("requests.xlsx", async (wb) => {
  const ws = wb.addWorksheet("Requests");
  ws.columns = [
    { header: "RequestId", key: "id", width: 12 },
    { header: "Amount", key: "amount", width: 12 },
    { header: "Category", key: "category", width: 18 },
    { header: "Requester", key: "requester", width: 20 },
  ];
  // 10 auto-approved (amount<5000 AND category != consulting),
  // 10 rejected — interleaved.
  const rows = [
    ["R-001", 1500, "hardware", "Alice"], // YES
    ["R-002", 6000, "consulting", "Bob"], // NO (over + consulting)
    ["R-003", 4500, "software", "Carol"], // YES
    ["R-004", 4800, "consulting", "Diana"], // NO (consulting)
    ["R-005", 2000, "hardware", "Evan"], // YES
    ["R-006", 5500, "hardware", "Frank"], // NO (over)
    ["R-007", 1200, "training", "Grace"], // YES
    ["R-008", 4999, "consulting", "Hiro"], // NO (consulting)
    ["R-009", 3000, "software", "Ivy"], // YES
    ["R-010", 8000, "software", "Jamal"], // NO (over)
    ["R-011", 100, "misc", "Kara"], // YES
    ["R-012", 4900, "software", "Luis"], // YES
    ["R-013", 7500, "training", "Maya"], // NO (over)
    ["R-014", 800, "hardware", "Nico"], // YES
    ["R-015", 3500, "consulting", "Owen"], // NO (consulting)
    ["R-016", 4200, "training", "Priya"], // YES
    ["R-017", 5000, "software", "Quinn"], // NO (>= 5000, boundary)
    ["R-018", 3300, "hardware", "Riley"], // YES
    ["R-019", 9999, "consulting", "Sasha"], // NO (over + consulting)
    ["R-020", 2500, "consulting", "Theo"], // NO (consulting)
  ];
  for (const r of rows) {
    ws.addRow({
      id: r[0],
      amount: r[1],
      category: r[2],
      requester: r[3],
    });
  }
});

// PDF #8 — vendors.pdf : identifies the "vendor of the year" by name,
// the multi-hop key into budgets.xlsx below.
await buildPdf("vendors.pdf", (doc) => {
  doc.fontSize(20).text("Vendor Performance Review 2024", { align: "center" });
  doc.moveDown(2);
  doc.fontSize(12).text(
    "The procurement team reviews vendor performance at the end of each fiscal year. The reviewed vendors for 2024 are: Acme, Globex, Initech, Umbrella, and Stark.",
  );
  doc.moveDown();
  doc.text(
    "Performance is scored on three axes: on-time delivery, pricing competitiveness, and incident response. Detailed scorecards are kept by the procurement team.",
  );
  doc.moveDown(2);
  doc.fontSize(14).text("Award");
  doc.moveDown();
  doc.fontSize(12).text(
    "Based on this year's scoring, the vendor of the year for 2024 is Globex. Globex achieved 98% on-time delivery, the highest among reviewed vendors, while maintaining competitive pricing across all SKUs.",
  );
  doc.moveDown();
  doc.text(
    "Monthly spend across all reviewed vendors is tracked in the companion file `budgets.xlsx`.",
  );
});

// XLSX #5 — budgets.xlsx : monthly spend per vendor for H1 2024.
// Globex March = 12000 (unique value — appears nowhere else in the
// sheet, so a grep on "12000" is unambiguous; the join via the
// vendor name is the actual test).
await buildXlsx("budgets.xlsx", async (wb) => {
  const ws = wb.addWorksheet("Budgets");
  ws.columns = [
    { header: "Vendor", key: "vendor", width: 14 },
    { header: "Jan", key: "jan", width: 10 },
    { header: "Feb", key: "feb", width: 10 },
    { header: "Mar", key: "mar", width: 10 },
    { header: "Apr", key: "apr", width: 10 },
    { header: "May", key: "may", width: 10 },
    { header: "Jun", key: "jun", width: 10 },
  ];
  const rows = [
    ["Acme", 5000, 5500, 6000, 6200, 6500, 6800],
    ["Globex", 9000, 10500, 12000, 11000, 10800, 10200],
    ["Initech", 3000, 3200, 3300, 3400, 3500, 3600],
    ["Umbrella", 4500, 4700, 4900, 5100, 5300, 5500],
    ["Stark", 7000, 7200, 7500, 7800, 8000, 8200],
  ];
  for (const r of rows) {
    ws.addRow({
      vendor: r[0],
      jan: r[1],
      feb: r[2],
      mar: r[3],
      apr: r[4],
      may: r[5],
      jun: r[6],
    });
  }
});

// XLSX #6 — orders-multisheet.xlsx : 2-sheet JOIN (Customers ↔ Orders).
// Question target: "name of the customer with the single largest
// order?" → "Initech LLC" (customer C3, order O103, amount 9999).
await buildXlsx("orders-multisheet.xlsx", async (wb) => {
  const customers = wb.addWorksheet("Customers");
  customers.columns = [
    { header: "CustomerId", key: "customer_id", width: 12 },
    { header: "Name", key: "name", width: 24 },
  ];
  const customerRows = [
    ["C1", "Acme Corp"],
    ["C2", "Globex Industries"],
    ["C3", "Initech LLC"],
    ["C4", "Umbrella Group"],
    ["C5", "Stark Enterprises"],
  ];
  for (const r of customerRows) {
    customers.addRow({ customer_id: r[0], name: r[1] });
  }
  const orders = wb.addWorksheet("Orders");
  orders.columns = [
    { header: "OrderId", key: "order_id", width: 10 },
    { header: "CustomerId", key: "customer_id", width: 12 },
    { header: "Amount", key: "amount", width: 12 },
  ];
  const orderRows = [
    ["O100", "C1", 5000],
    ["O101", "C2", 8500],
    ["O102", "C1", 1200],
    ["O103", "C3", 9999], // ← single-largest order, customer = C3 (Initech LLC)
    ["O104", "C4", 4500],
    ["O105", "C2", 3000],
    ["O106", "C5", 7000],
    ["O107", "C3", 800],
    ["O108", "C1", 2500],
    ["O109", "C4", 1500],
  ];
  for (const r of orderRows) {
    orders.addRow({ order_id: r[0], customer_id: r[1], amount: r[2] });
  }
});

// PDF #9 — compliance-handbook-2022.pdf : LEGACY copy of the handbook
// with an OUTDATED CFO-approval threshold. Used together with the
// current compliance-handbook.pdf (threshold = 2500) in
// `gaia-hard-stale-source` — the agent must pick the current version,
// not the legacy. Fewer pages than the current one (5 vs 12) to keep
// it cheap; the legacy threshold (1000) appears in the same Section
// 4.1 / Exceptions slot for symmetry.
await buildPdf("compliance-handbook-2022.pdf", (doc) => {
  doc.fontSize(22).text("Acme Corp Compliance Handbook 2022 (LEGACY)", {
    align: "center",
  });
  doc.moveDown();
  doc.fontSize(12).text(
    "This is the 2022 edition of the compliance handbook. It has been superseded by the 2024 edition. Refer to compliance-handbook.pdf for current policy.",
  );
  doc.addPage();
  doc.fontSize(18).text("Section 1 — Onboarding (2022)");
  doc.moveDown();
  doc.fontSize(12).text(
    "Onboarding completed within five business days. Mandatory training covers information security and data privacy.",
  );
  doc.addPage();
  doc.fontSize(18).text("Section 2 — Compensation (2022)");
  doc.moveDown();
  doc.fontSize(12).text(
    "The starting salary for a junior engineer in 2022 was 65000 USD per year. Equity grants follow a 4-year vest with 1-year cliff.",
  );
  doc.addPage();
  doc.fontSize(18).text("Section 4 — Travel Reimbursement (2022)");
  doc.moveDown();
  doc.fontSize(12).text(
    "Per-diem meal allowance was 50 USD per day in 2022.",
  );
  doc.moveDown();
  doc.fontSize(14).text("Section 4.1 — Exceptions (2022)");
  doc.moveDown(0.5);
  doc.fontSize(12).text(
    "Air travel exceeding 1000 USD required CFO approval before booking under the 2022 policy. This threshold was raised in the 2024 edition.",
  );
  doc.addPage();
  doc.fontSize(18).text("Section 6 — Termination (2022)");
  doc.moveDown();
  doc.fontSize(12).text(
    "Severance was one week of base salary per year of service in 2022, capped at 25000 USD.",
  );
});

console.log("✓ wrote 12 fixtures to", HERE);
