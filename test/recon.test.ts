// Run: npm test   (optional: OUT_0908=/path/AuthorizeNet_08_Sep_output.xlsx npm test)
import assert from "node:assert/strict";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { reconcile, scenarioOf } from "../lib/recon";
import { explainFailure, detectPrefix } from "../lib/qb";
import type { QDoc, QLine } from "../lib/qb";
import type { Row } from "../lib/settlement";
import { parseSettlement } from "../lib/settlement";
import { buildOutput } from "../lib/outputSheet";

const row = (order: string, amount: number, fileTax: number, type: "sale" | "refund" = "sale"): Row => ({ order, type, amount, fileTax, fileFreight: 0, txnId: "t" + order, customer: "" });
const line = (name: string, amount: number, taxCode = "TAX"): QLine => ({ kind: "item", itemId: name === "Shipping" ? "9" : "1", name, qty: 1, rate: amount, amount, taxCode });
function doc(order: string, lines: QLine[], tax: number, kind: "sale" | "refund" = "sale"): QDoc {
  const total = Math.round((lines.reduce((t, l) => t + l.amount, 0) + tax) * 100) / 100;
  return { kind, id: "q" + order, syncToken: "0", docNumber: "Woo Order#" + order, total, tax, lines, inDeposit: false, customer: "Some One", raw: {} };
}

assert.equal(scenarioOf(11.88, 11.88), "C");
assert.equal(scenarioOf(0, 8.62), "A");
assert.equal(scenarioOf(5.02, 5.94), "B");
assert.equal(scenarioOf(5, 0), "D");

// matched
{ const v = reconcile(row("1", 200.07, 12.67), doc("1", [line("Product", 187.4)], 12.67)); assert.equal(v.status, "Matched"); assert.equal(v.plan.tax, undefined); }

// not found: nothing planned, row kept
{ const v = reconcile(row("2", 50, 3), null); assert.equal(v.status, "Not found"); assert.equal(v.fileTax, 3); assert.equal(v.qboTotal, 0); assert.ok(v.blockers[0]); }

// B: QBO tax higher because shipping is taxed (video example: 0.99 on shipping) -> untax shipping
{ const q = doc("73095", [line("Product", 36.15), line("Shipping", 8.84)], 5.04); // shipping tax = 0.99
  const v = reconcile(row("73095", 49.04, 4.05), q);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "B"); assert.equal(v.taxDiff, -0.99);
  assert.deepEqual(v.plan.tax, { mode: "set", total: 4.05 }); assert.equal(v.plan.untaxShipping?.name, "Shipping"); }

// B: QBO tax higher but shipping does not explain it -> plain set (override)
{ const q = doc("3", [line("Product", 60)], 5.94); const v = reconcile(row("3", 65.01, 5.01), q);
  assert.equal(v.status, "Needs fix"); assert.equal(v.plan.untaxShipping, undefined); assert.deepEqual(v.plan.tax, { mode: "set", total: 5.01 }); }

// A: file has no tax, QBO taxed -> remove
{ const q = doc("4", [line("Product", 160.49)], 8.62); const v = reconcile(row("4", 160.49, 0), q);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "A"); assert.deepEqual(v.plan.tax, { mode: "remove" }); }

// D: file has tax, QBO none -> set
{ const q = doc("5", [line("Product", 100, "NON")], 0); const v = reconcile(row("5", 108, 8), q);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "D"); assert.deepEqual(v.plan.tax, { mode: "set", total: 8 }); }

// not only tax (a line is missing): review, nothing planned
{ const q = doc("6", [line("Product", 100)], 8); const v = reconcile(row("6", 120, 8), q);
  assert.equal(v.status, "Pending review"); assert.equal(v.plan.tax, undefined); assert.ok(v.blockers[0].includes("not tax")); }
// tax equal but total differs: review
{ const q = doc("7", [line("Product", 100)], 8); const v = reconcile(row("7", 113.99, 8), q); assert.equal(v.status, "Pending review"); }

// refunds are never changed automatically
{ const q = doc("8", [line("Product", 50)], 4, "refund"); const v = reconcile(row("8", -50, 0, "refund"), q);
  assert.equal(v.status, "Pending review"); assert.equal(v.plan.tax, undefined); }
{ const q = doc("9", [line("Product", 50)], 4, "refund"); assert.equal(reconcile(row("9", -54, 4, "refund"), q).status, "Matched"); }

// prefix detection
assert.equal(detectPrefix(["Order#73102", "Order#73103", "X9"], new Set(["73102", "73103"])), "Order#");
assert.equal(detectPrefix(["73102"], new Set(["73102"])), "");
assert.equal(detectPrefix(["A1"], new Set(["73102"])), null);

// failure reasons
assert.match(explainFailure(new Error("Stale object error: syncToken")), /Someone changed/);
assert.match(explainFailure(null, { taxStillWrong: true }), /did not take/);

(async () => {
  // output workbook: same layout, F/M follow the fixed receipt, TaxDiff = L - M
  const before = reconcile(row("73095", 49.04, 4.05), doc("73095", [line("Product", 36.15), line("Shipping", 8.84)], 5.04));
  const after = reconcile(row("73095", 49.04, 4.05), doc("73095", [line("Product", 36.15), line("Shipping", 8.84, "NON")], 4.05));
  const nf = reconcile(row("999", 10, 1), null);
  for (const v of [before, nf]) v.date = "09/08/2026";
  const { buffer, filename } = await buildOutput([{ ...before, after, final: "Corrected, verified" }, nf]);
  assert.equal(filename, "AuthorizeNet_08_Sep_output.xlsx");
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["main", "Sales_Authnet", "Changes"]);
  const m = wb.getWorksheet("main")!, o = wb.getWorksheet("Sales_Authnet")!;
  assert.equal(m.getRow(1).getCell(12).value, "Order Total Tax Amount");
  assert.equal(m.getRow(2).getCell(6).value, 49.04); assert.equal(m.getRow(2).getCell(13).value, 4.05); // fixed values
  assert.equal(o.getRow(2).getCell(13).value, 5.04);                                                       // old values kept on the other sheet
  assert.equal(m.getRow(3).getCell(6).value, ""); assert.equal(m.getRow(3).getCell(12).value, 1);          // not found: QBO blank, file tax kept
  console.log("logic + output workbook tests passed");

  const f = process.env.OUT_0908;
  if (f && fs.existsSync(f)) {
    const s = parseSettlement(fs.readFileSync(f).buffer.slice(0) as ArrayBuffer);
    assert.ok(s.rows.length > 0); assert.ok(s.rows.some((r) => r.fileTax > 0));
    console.log(`parsed ${s.rows.length} rows from ${f}`);
  } else console.log("(skipped parser test: set OUT_0908)");
})();
