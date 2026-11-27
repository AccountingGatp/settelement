// Run: npm test   (optional: OUT_0908=/path/AuthorizeNet_08_Sep_output.xlsx npm test)
import assert from "node:assert/strict";
import fs from "node:fs";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { reconcile, scenarioOf, verified } from "../lib/recon";
import { explainFailure, detectPrefix, retargetTax } from "../lib/qb";
import type { QDoc, QLine } from "../lib/qb";
import type { Row } from "../lib/settlement";
import { parseSettlement } from "../lib/settlement";
import { buildOutput } from "../lib/outputSheet";

const row = (order: string, amount: number, fileTax: number, type: "sale" | "refund" = "sale"): Row => ({ order, type, amount, fileTax, fileFreight: 0, txnId: "t" + order, customer: "" });
const line = (name: string, amount: number, taxCode = "TAX"): QLine => ({ kind: "item", itemId: name === "Shipping" ? "9" : "1", name, qty: 1, rate: amount, amount, taxCode });
function doc(order: string, lines: QLine[], tax: number, kind: "sale" | "refund" = "sale"): QDoc {
  const total = Math.round((lines.reduce((t, l) => t + l.amount, 0) + tax) * 100) / 100;
  return { kind, id: "q" + order, syncToken: "0", docNumber: (kind === "refund" ? "Woo Refund#" : "Woo Order#") + order, total, tax, lines, inDeposit: false, customer: "Some One", raw: {} };
}

assert.equal(scenarioOf(11.88, 11.88), "C");
assert.equal(scenarioOf(0, 8.62), "A");
assert.equal(scenarioOf(5.02, 5.94), "B");
assert.equal(scenarioOf(5, 0), "D");

// matched
{ const v = reconcile(row("1", 200.07, 12.67), doc("1", [line("Product", 187.4)], 12.67)); assert.equal(v.status, "Matched"); assert.equal(v.plan.tax, undefined); }

// not found: nothing planned, row kept
{ const v = reconcile(row("2", 50, 3), null); assert.equal(v.status, "Not found"); assert.equal(v.fileTax, 3); assert.equal(v.qboTotal, 0); assert.ok(v.blockers[0]); }

// B: A shipping line is present. Adjust the total tax directly.
{ const q = doc("73095", [line("Product", 36.15), line("Shipping", 8.84)], 5.04); // shipping tax = 0.99
  const v = reconcile(row("73095", 49.04, 4.05), q);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "B"); assert.equal(v.taxDiff, -0.99);
  assert.deepEqual(v.plan.tax, { mode: "set", total: 4.05 }); }

// B: real 85153 shape: discount line, shipping is QuickBooks's shipping field with no tax code, surplus tax 0.91 = tax on shipping
{ const q: QDoc = { kind: "sale", id: "q85153", syncToken: "0", docNumber: "Woo Order#85153", total: 108.47, tax: 7.24, inDeposit: false, customer: "X", raw: {}, lines: [line("Gas Money", 47.49), line("Orange", 47.49), { kind: "discount", itemId: "", name: "Discount", qty: 0, rate: 0, amount: 4.74, taxCode: "" }, { kind: "item", itemId: "SHIPPING_ITEM_ID", name: "Shipping", qty: 1, rate: 10.99, amount: 10.99, taxCode: "" }] };
  const v = reconcile(row("85153", 107.56, 6.33), q);
  assert.equal(v.status, "Needs fix"); assert.deepEqual(v.plan.tax, { mode: "set", total: 6.33 }); }

// B: QBO tax higher but shipping does not explain it -> plain set (override)
{ const q = doc("3", [line("Product", 60)], 5.94); const v = reconcile(row("3", 65.01, 5.01), q);
  assert.equal(v.status, "Needs fix"); assert.deepEqual(v.plan.tax, { mode: "set", total: 5.01 }); }

// A: file has no tax, QBO taxed -> remove
{ const q = doc("4", [line("Product", 160.49)], 8.62); const v = reconcile(row("4", 160.49, 0), q);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "A"); assert.deepEqual(v.plan.tax, { mode: "remove" }); }

// D: file has tax, QBO none -> set
{ const q = doc("5", [line("Product", 100, "NON")], 0); const v = reconcile(row("5", 108, 8), q);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "D"); assert.deepEqual(v.plan.tax, { mode: "set", total: 8 }); }

// not only tax (a line is missing): review, nothing planned
{ const q = doc("6", [line("Product", 100)], 8); const v = reconcile(row("6", 120, 8), q);
  assert.equal(v.status, "Pending review"); assert.equal(v.plan.tax, undefined); assert.ok(v.blockers[0].includes("amount before tax")); }
// tax equal but total differs: review
{ const q = doc("7", [line("Product", 100)], 8); const v = reconcile(row("7", 113.99, 8), q); assert.equal(v.status, "Pending review"); }

// A one-cent tax-only difference in either direction requires a fix and cannot pass verification.
for (const tax of [3.99, 4.01]) {
  const v = reconcile(row("8", 54, 4), doc("8", [line("Product", 50)], tax));
  assert.equal(v.status, "Needs fix");
  assert.equal(Math.abs(v.taxDiff!), 0.01);
  assert.equal(verified(v), false);
}
assert.equal(scenarioOf(0, 0.01), "A");
assert.equal(scenarioOf(0.01, 0), "D");
assert.equal(reconcile(row("8", 54, 4), doc("8", [line("Product", 49.99)], 4)).status, "Pending review");

// Refunds use the same exact tax-only test when the file specifies refunded tax.
const refund = row("9", -54, 4, "refund");
const refundDoc = doc("9", [line("Product", 50)], 4.01, "refund");
assert.equal(reconcile(refund, refundDoc).status, "Needs fix");
assert.equal(reconcile({ ...refund, fileTax: null }, refundDoc).status, "Pending review");
assert.equal(reconcile({ ...refund, amount: -53 }, refundDoc).status, "Pending review");
assert.equal(reconcile({ ...refund, reviewReason: "Ambiguous refund" }, refundDoc).status, "Pending review");
assert.equal(reconcile({ ...refund, amount: -50, fileTax: 0 }, refundDoc).plan.tax?.mode, "remove");
assert.equal(verified(reconcile(refund, doc("9", [line("Product", 50)], 4, "refund"))), true);

const workbookSource = XLSX.utils.book_new();
const sourceSheet = XLSX.utils.aoa_to_sheet([
  ["Linked Transaction Number", "Linked Transaction Type", "File Amount", "Order Total Tax Amount", "Refund Tax Amount"],
  ["Woo Refund#100", "RefundReceipt", -54, 8, 4],
  ["Woo Refund#101", "RefundReceipt", -22, 8, ""],
  ["Woo Order#102", "SalesReceipt", 54, 4, ""],
  ["Woo Refund#102", "RefundReceipt", -54, 8, ""],
  ["Woo Refund#103", "RefundReceipt", -45.45, -2.77, ""],
  ["Woo Refund#104", "RefundReceipt", -57.67, 0, ""],
  ["Woo Refund#105", "RefundReceipt", -57.67, "-", ""],
]);
sourceSheet.D7.z = '0.00;-0.00;"-"';
XLSX.utils.book_append_sheet(workbookSource, sourceSheet, "main");
const workbookRows = parseSettlement(XLSX.write(workbookSource, { bookType: "xlsx", type: "array" })).rows;
assert.deepEqual(workbookRows.map((r) => r.fileTax), [4, null, 4, 4, 2.77, null, null]);
assert.equal(workbookRows[0].docNumber, "Woo Refund#100");
const legacyRefund = workbookRows[4];
const bookedRefund = doc("103", [line("Product", 40.99)], 2.77, "refund");
assert.equal(reconcile(legacyRefund, bookedRefund).status, "Pending review");
const enabledRefund = reconcile(legacyRefund, bookedRefund, { id: "500", name: "Refund adjustment" });
assert.equal(enabledRefund.status, "Needs fix");
assert.equal(enabledRefund.taxDiff, 0);
assert.equal(enabledRefund.totalDiff, 1.69);
assert.deepEqual(enabledRefund.plan.adjustment, { id: "500", name: "Refund adjustment", amount: 1.69 });
assert.equal(enabledRefund.plan.tax, undefined);

const dashFormattedZero = workbookRows[5];
const zeroTaxReceipt = doc("104", [line("Product", 57.67)], 0, "refund");
assert.equal(dashFormattedZero.legacyRefundZeroTax, true);
assert.equal(verified(reconcile(dashFormattedZero, zeroTaxReceipt)), true);
assert.equal(reconcile(dashFormattedZero, zeroTaxReceipt).taxDiff, 0);
assert.deepEqual(reconcile(dashFormattedZero, zeroTaxReceipt).plan, {});
assert.equal(reconcile({ ...dashFormattedZero, amount: -58 }, zeroTaxReceipt).status, "Pending review");
assert.equal(reconcile(dashFormattedZero, doc("104", [line("Product", 56.67)], 1, "refund")).status, "Pending review");
assert.equal(reconcile(workbookRows[6], zeroTaxReceipt).status, "Pending review");

const lineSource = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(lineSource, XLSX.utils.aoa_to_sheet([
  ["Linked Transaction Number", "Line Amount", "File Amount", "Order Total Tax Amount"],
  ["Woo Order#200", 61.25, 60, 5],
  ["Woo Order#201", 60, "", 5],
]), "main");
const [lineMismatch, missingTarget] = parseSettlement(XLSX.write(lineSource, { bookType: "xlsx", type: "array" })).rows;
const live = doc("200", [line("Product", 55)], 5);
assert.equal(lineMismatch.amount, 60);
assert.equal(reconcile(lineMismatch, live).totalDiff, 0);
assert.equal(reconcile(lineMismatch, live).lineDiff, 1.25);
assert.equal(reconcile(missingTarget, live).status, "Pending review");


const csv = [
  "Transaction ID,Transaction Status,Transaction Type,Settlement Amount,Invoice Number,L2 - Tax",
  "500,Credited,Refund,-54,100,4",
  "501,Settled Successfully,Refund,-54,100,4",
  "502,Credited,Refund,-22,101,",
  "503,Credited,Refund,-10,102,0",
].join("\n");
const rawRows = parseSettlement(Uint8Array.from(Buffer.from(csv)).buffer).rows;
assert.deepEqual(rawRows.map((r) => r.fileTax), [4, 4, null, 0]);
assert.equal(rawRows[1].type, "refund");
assert.ok(rawRows[0].reviewReason && rawRows[1].reviewReason);

// prefix detection
assert.equal(detectPrefix(["Order#73102", "Order#73103", "X9"], new Set(["73102", "73103"])), "Order#");
assert.equal(detectPrefix(["73102"], new Set(["73102"])), "");
assert.equal(detectPrefix(["A1"], new Set(["73102"])), null);

// tax override: new total is spread over the tax lines, differences recorded as override amounts
{ const td = { TotalTax: 7.24, TaxLine: [{ Amount: 4.0, TaxLineDetail: { OverrideDeltaAmount: 0 } }, { Amount: 3.24, TaxLineDetail: {} }] };
  const t = retargetTax(td, 6.33);
  assert.equal(t.TotalTax, 6.33); assert.equal(Math.round((t.TaxLine[0].Amount + t.TaxLine[1].Amount) * 100) / 100, 6.33);
  assert.equal(Math.round((t.TaxLine[0].TaxLineDetail.OverrideDeltaAmount + t.TaxLine[1].TaxLineDetail.OverrideDeltaAmount) * 100) / 100, -0.91);
  assert.equal(td.TaxLine[0].Amount, 4.0); // the input is not changed
  assert.throws(() => retargetTax({ TotalTax: 1 }, 2), /no tax line/); }

// failure reasons
assert.match(explainFailure(new Error("Stale object error: syncToken")), /Someone changed/);
assert.match(explainFailure(null, { taxStillWrong: true }), /did not take/);

(async () => {
  // output workbook: same layout, F/M follow the fixed receipt, TaxDiff = L - M
  const before = reconcile(row("73095", 49.04, 4.05), doc("73095", [line("Product", 36.15), line("Shipping", 8.84)], 5.04));
  const after = reconcile(row("73095", 49.04, 4.05), doc("73095", [line("Product", 36.15), line("Shipping", 8.84, "NON")], 4.05));
  const nf = reconcile(row("999", 10, 1), null);
  for (const v of [before, nf]) v.date = "09/08/2026";
  after.date = before.date;
  const { buffer, filename } = await buildOutput([{ ...after, before, final: "Corrected, verified" }, nf]);
  assert.equal(filename, "AuthorizeNet_08_Sep_output.xlsx");
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["main", "Sales_Authnet", "Changes"]);
  const m = wb.getWorksheet("main")!, o = wb.getWorksheet("Sales_Authnet")!;
  assert.equal(m.getRow(1).getCell(12).value, "Order Total Tax Amount");
  assert.equal(m.getRow(2).getCell(6).value, 49.04); assert.equal(m.getRow(2).getCell(13).value, 4.05); // fixed values
  assert.equal(m.getRow(2).getCell(14).formula, "ROUND(L2-M2,2)");
  assert.equal(XLSX.read(buffer, { type: "buffer" }).Sheets.main.N2.v, 0);
  assert.equal(o.getRow(2).getCell(13).value, 5.04);                                                       // old values kept on the other sheet
  assert.equal(m.getRow(3).getCell(6).value, ""); assert.equal(m.getRow(3).getCell(12).value, 1);          // not found: QBO blank, file tax kept
  const zeroTaxRefund = reconcile({ ...refund, amount: -50, fileTax: 0 }, doc("9", [line("Product", 50)], 0, "refund"));
  const zeroRefundOutput = (await buildOutput([zeroTaxRefund])).buffer;
  assert.equal(parseSettlement(Uint8Array.from(zeroRefundOutput).buffer).rows[0].fileTax, 0);
  console.log("logic + output workbook tests passed");

  const f = process.env.OUT_0908;
  if (f && fs.existsSync(f)) {
    const s = parseSettlement(fs.readFileSync(f).buffer.slice(0) as ArrayBuffer);
    assert.ok(s.rows.length > 0); assert.ok(s.rows.some((r) => (r.fileTax ?? 0) > 0));
    console.log(`parsed ${s.rows.length} rows from ${f}`);
  } else console.log("(skipped parser test: set OUT_0908)");
})();
