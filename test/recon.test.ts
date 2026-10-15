// Run: npm test   (optional: DL_0908=/path/8_sep_download.xlsx DL_0909=/path/9_sep_download.xlsx npm test)
import assert from "node:assert/strict";
import fs from "node:fs";
import { reconcile, scenarioOf } from "../lib/recon";
import type { WOrder } from "../lib/woo";
import type { QDoc, QItem } from "../lib/qb";
import type { Row } from "../lib/settlement";
import { parseSettlement } from "../lib/settlement";

const items: QItem[] = [
  { id: "1", name: "Product", sku: "P1", type: "Service", active: true },
  { id: "2", name: "Order protection", sku: "", type: "Service", active: true },
  { id: "3", name: "Cold packaging", sku: "", type: "Service", active: true },
];
const row = (order: string, amount: number, type: "sale" | "refund" = "sale"): Row => ({ order, type, amount, fileTax: 0, fileFreight: 0, txnId: "t" + order, customer: "" });

/** Build a Woo order and a QBO receipt from totals. `missing` = fee lines Woo has and QBO lacks. */
function mk(order: string, settle: number, wooTax: number, qTotal: number, qTax: number, missing: { name: string; amount: number }[] = []) {
  const wooPre = Math.round((settle - wooTax) * 100) / 100;
  const missSum = missing.reduce((s, m) => s + m.amount, 0);
  const itemAmt = Math.round((wooPre - missSum) * 100) / 100;
  const woo: WOrder = {
    order, status: "completed", total: settle, tax: wooTax, shippingTax: 0, shipping: 0, discount: 0, refunds: [],
    lines: [{ kind: "item", sku: "P1", name: "Product", qty: 1, amount: itemAmt, tax: 0 }, ...missing.map((m) => ({ kind: "fee" as const, sku: "", name: m.name, qty: 1, amount: m.amount, tax: 0 }))],
  };
  const qItem = Math.round((qTotal - qTax) * 100) / 100;
  const q: QDoc = {
    kind: "sale", id: "q" + order, syncToken: "0", docNumber: "Woo Order#" + order, total: qTotal, tax: qTax, inDeposit: false, customer: "", raw: {},
    lines: [{ kind: "item", itemId: "1", name: "Product", sku: "P1", qty: 1, rate: qItem, amount: qItem, taxCode: "TAX" }],
  };
  return { woo, q };
}

// --- scenarios
assert.equal(scenarioOf(11.88, 11.88), "C");
assert.equal(scenarioOf(0, 8.62), "A");
assert.equal(scenarioOf(5.02, 5.94), "B");
assert.equal(scenarioOf(5, 0), "D");

// matched
{ const { woo, q } = mk("1", 200.07, 12.67, 200.07, 12.67); const v = reconcile(row("1", 200.07), woo, q, items); assert.equal(v.status, "Matched"); assert.equal(v.plan.tax, undefined); }

// scenario B: QBO tax higher (order 73199 style)
{ const { woo, q } = mk("73199", 65.01, 5.02, 65.93, 5.94); const v = reconcile(row("73199", 65.01), woo, q, items);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "B"); assert.equal(v.taxDiff, -0.92);
  assert.deepEqual(v.plan.tax, { mode: "set", total: 5.02 }); assert.equal(v.plan.addLines.length, 0); }

// scenario A: Woo has no tax, QBO taxed (order 73212 style)
{ const { woo, q } = mk("73212", 160.49, 0, 163.12, 8.62, [{ name: "Order protection", amount: 5.99 }]); const v = reconcile(row("73212", 160.49), woo, q, items);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "A"); assert.deepEqual(v.plan.tax, { mode: "remove" });
  assert.equal(v.plan.addLines.length, 1); assert.equal(v.plan.addLines[0].amount, 5.99); assert.equal(v.plan.addLines[0].itemId, "2"); }

// missing fee only (order 73206 style)
{ const { woo, q } = mk("73206", 172.46, 11.28, 166.47, 11.28, [{ name: "Cold packaging", amount: 5.99 }]); const v = reconcile(row("73206", 172.46), woo, q, items);
  assert.equal(v.status, "Needs fix"); assert.equal(v.scenario, "C"); assert.equal(v.plan.tax, undefined); assert.equal(v.plan.addLines[0].itemName, "Cold packaging"); }

// missing fee with NO matching QBO item -> review, nothing planned to write
{ const { woo, q } = mk("73206", 172.46, 11.28, 166.47, 11.28, [{ name: "Mystery fee", amount: 5.99 }]); const v = reconcile(row("73206", 172.46), woo, q, items);
  assert.equal(v.status, "Pending review"); assert.ok(v.blockers.some((b) => /No QuickBooks item/.test(b))); }

// gap that no single line explains (order 73289 style, 0.24): Woo is the truth, so the lines are rebuilt from Woo
{ const { woo, q } = mk("73289", 139.72, 10.05, 139.48, 10.05); const v = reconcile(row("73289", 139.72), woo, q, items);
  assert.equal(v.status, "Needs fix"); assert.ok(v.plan.replaceLines && v.plan.replaceLines.length === 1); assert.equal(v.plan.replaceLines![0].amount, 129.67); assert.equal(v.plan.replaceLines![0].itemId, "1"); }

// price differs on a matched line -> rebuilt, and tax is set too
{ const { woo, q } = mk("20", 110, 10, 120, 8); const v = reconcile(row("20", 110), woo, q, items);
  assert.equal(v.status, "Needs fix"); assert.ok(v.plan.replaceLines); assert.deepEqual(v.plan.tax, { mode: "set", total: 10 }); assert.ok(v.issues.some((i) => /Line/.test(i.field) && i.auto)); }

// extra line in QBO that Woo does not have -> removed by the rebuild
{ const { woo, q } = mk("21", 100, 0, 106, 0); q.lines.push({ kind: "item", itemId: "2", name: "Order protection", sku: "", qty: 1, rate: 6, amount: 6, taxCode: "NON" }); q.lines[0].amount = 100; q.lines[0].rate = 100;
  const v = reconcile(row("21", 100), woo, q, items);
  assert.equal(v.status, "Needs fix"); assert.equal(v.plan.replaceLines?.length, 1); assert.ok(v.issues.some((i) => /Extra line/.test(i.field))); }

// Woo discount as a negative fee that QBO never had: rebuilt with a discount line, total ends at Woo's
{ const { woo, q } = mk("22", 90, 0, 100, 0); woo.lines = [{ kind: "item", sku: "P1", name: "Product", qty: 1, amount: 100, tax: 0 }, { kind: "fee", sku: "", name: "10% off", qty: 1, amount: -10, tax: 0 }]; woo.discount = 0;
  const v = reconcile(row("22", 90), woo, q, items);
  assert.equal(v.status, "Needs fix"); assert.equal(v.plan.replaceLines?.length, 2); assert.equal(v.plan.replaceLines![1].discount, true); assert.equal(v.plan.replaceLines![1].amount, 10); }

// Woo coupon discount, QBO lines already at the discounted amount: nothing to rebuild, only the tax is set (order 73286 style)
{ const { woo, q } = mk("73286", 39.18, 1.6, 37.58, 0); woo.discount = 5; q.lines[0].taxCode = "NON"; const v = reconcile(row("73286", 39.18), woo, q, items);
  assert.equal(v.status, "Needs fix"); assert.equal(v.plan.replaceLines, undefined); assert.deepEqual(v.plan.tax, { mode: "set", total: 1.6 }); assert.equal(v.scenario, "D"); }

// rebuild needs an item for every Woo line; none for a new line -> review
{ const { woo, q } = mk("23", 100, 0, 90, 0, [{ name: "Mystery fee", amount: 10 }]); woo.lines[0].amount = 95; woo.lines[1].amount = 5; const v = reconcile(row("23", 100), woo, q, items);
  assert.equal(v.status, "Pending review"); assert.ok(v.blockers.some((b) => /No QuickBooks item/.test(b))); }

// Woo total differs from settlement -> review
{ const { woo, q } = mk("9", 100, 5, 100, 5); woo.total = 90; const v = reconcile(row("9", 100), woo, q, items); assert.equal(v.status, "Pending review"); }

// not found
assert.equal(reconcile(row("5", 10), null, null, items).status, "Not found");
{ const { woo } = mk("5", 10, 0, 10, 0); const v = reconcile(row("5", 10), woo, null, items); assert.equal(v.status, "Not found"); assert.match(v.blockers[0], /QuickBooks/); }

// in deposit is flagged, not skipped
{ const { woo, q } = mk("73199", 65.01, 5.02, 65.93, 5.94); q.inDeposit = true; const v = reconcile(row("73199", 65.01), woo, q, items); assert.equal(v.status, "Needs fix"); assert.ok(v.inDeposit && v.notes.includes("In deposit")); }

// refund: tax-only difference (QBO total moves with its tax) -> fixable
{
  const woo: WOrder = { order: "70001", status: "refunded", total: 100, tax: 0, shippingTax: 0, shipping: 0, discount: 0, lines: [], refunds: [{ id: "1", total: 37.45, tax: 2.45, hasBreakdown: true }] };
  const q: QDoc = { kind: "refund", id: "r1", syncToken: "0", docNumber: "Woo Refund#70001", total: 37.95, tax: 2.95, lines: [], inDeposit: false, customer: "", raw: {} };
  const v = reconcile(row("70001", -37.45, "refund"), woo, q, items);
  assert.equal(v.taxDiff, -0.5); assert.equal(v.scenario, "B"); assert.equal(v.status, "Needs fix"); assert.deepEqual(v.plan.tax, { mode: "set", total: 2.45 });
}
// refund 70317 as in the old sheet: totals equal but tax differs (10.22 vs 2.45). Fixing tax alone would break the total -> review
{
  const woo: WOrder = { order: "70317", status: "refunded", total: 100, tax: 0, shippingTax: 0, shipping: 0, discount: 0, lines: [], refunds: [{ id: "1", total: 37.45, tax: 10.22, hasBreakdown: true }] };
  const q: QDoc = { kind: "refund", id: "r1", syncToken: "0", docNumber: "Woo Refund#70317", total: 37.45, tax: 2.45, lines: [], inDeposit: false, customer: "", raw: {} };
  const v = reconcile(row("70317", -37.45, "refund"), woo, q, items);
  assert.equal(v.taxDiff, 7.77); assert.equal(v.status, "Pending review");
}
// refund: amounts differ -> review
{
  const woo: WOrder = { order: "73187", status: "refunded", total: 100, tax: 0, shippingTax: 0, shipping: 0, discount: 0, lines: [], refunds: [{ id: "1", total: 68.55, tax: 5.22, hasBreakdown: true }] };
  const q: QDoc = { kind: "refund", id: "r2", syncToken: "0", docNumber: "Woo Refund#73187", total: 62.12, tax: 6.13, lines: [], inDeposit: false, customer: "", raw: {} };
  const v = reconcile(row("73187", -68.55, "refund"), woo, q, items);
  assert.equal(v.status, "Pending review");
}

// --- the two real days (numbers from the old output sheets), synthesized lines
import { SNAPSHOTS } from "../seed/snapshots";
function csv(day: string) { return SNAPSHOTS[day].map((r) => ({ order: r.order, type: r.type, settle: r.settle, wooTax: r.wooTax, qTotal: r.qboTotal, qTax: r.qboTax })); }
for (const [day, want] of [["0909", { sales: 49, taxDiff: 13, A: 6, B: 7, amountDiff: 20 }], ["0908", { sales: 61, taxDiff: 14, A: 5, B: 9, amountDiff: 18 }]] as const) {
  const rows = csv(day).filter((r) => r.type === "sale");
  let taxDiff = 0, A = 0, B = 0, amountDiff = 0;
  for (const r of rows) {
    const gap = Math.round((r.settle - r.qTotal - (r.wooTax - r.qTax)) * 100) / 100; // what is missing before tax
    const { woo, q } = mk(r.order, r.settle, r.wooTax, r.qTotal, r.qTax, gap > 0.01 ? [{ name: "Cold packaging", amount: gap }] : []);
    const v = reconcile(row(r.order, r.settle), woo, q, items);
    if (Math.abs(v.taxDiff) > 0.01) { taxDiff++; if (v.scenario === "A") A++; if (v.scenario === "B") B++; }
    if (Math.abs(v.totalDiff) > 0.01) amountDiff++;
  }
  assert.deepEqual({ sales: rows.length, taxDiff, A, B, amountDiff }, want, `day ${day}`);
}
import { explainFailure } from "../lib/qb";
assert.match(explainFailure(new Error("You need to activate this item before updating the quantity.")), /inactive/);
assert.match(explainFailure(new Error("Stale Object Error: SyncToken")), /changed the receipt/);
assert.equal(explainFailure(null, { taxStillWrong: true }), "QuickBooks did not take the new tax amount.");
// --- output workbook layout (same columns and sign rules as the team's file)
import { buildOutput, type OutRow } from "../lib/outputSheet";
import ExcelJS from "exceljs";
(async () => {
  const base = (o: Partial<OutRow>): OutRow => ({ order: "1", type: "sale", customer: "", date: "09/09/2026", depositNo: "AN0909", receivedFrom: "A B (a@b.com)", status: "Matched", scenario: "C", settle: 0, wooTotal: 0, wooTax: 0, qboTotal: 0, qboTax: 0, taxDiff: 0, totalDiff: 0, inDeposit: false, issues: [], plan: { addLines: [] }, blockers: [], notes: [], ...o });
  const fixedAfter = base({ order: "73199", settle: 65.01, wooTotal: 65.01, wooTax: 5.02, qboTotal: 65.93, qboTax: 5.94, status: "Needs fix", final: "Corrected, verified", plan: { addLines: [], tax: { mode: "set", total: 5.02 } }, issues: [{ field: "Tax", woo: "5.02", qbo: "5.94", diff: -0.92, note: "", auto: true }], after: base({ order: "73199", wooTax: 5.02, qboTotal: 65.01, qboTax: 5.02 }) });
  const refund = base({ order: "73187", type: "refund", settle: 68.55, wooTotal: 68.55, wooTax: 5.22, qboTotal: 62.12, qboTax: 6.13, status: "Pending review", blockers: ["refund differs"] });
  const nf = base({ order: "999", settle: 10, wooTax: 1, status: "Not found", blockers: ["not found"] });
  const rolled = base({ order: "5", settle: 100, wooTotal: 100, wooTax: 8, qboTotal: 100, qboTax: 0, status: "Needs fix", final: "Failed, rolled back", rolledBack: true, after: base({ qboTotal: 100, qboTax: 0, wooTax: 8 }) });
  const { buffer, filename } = await buildOutput([fixedAfter, refund, nf, rolled], "Test Account");
  assert.equal(filename, "AuthorizeNet_09_Sep_output.xlsx");
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["main", "Sales_Authnet", "Changes"]);
  const val = (c: ExcelJS.CellValue) => (c && typeof c === "object" && "formula" in c ? ((c as any).result ?? 0) : c); // a cached result of 0 is not stored; Excel recalculates on open
  const m = wb.getWorksheet("main")!, b = wb.getWorksheet("Sales_Authnet")!;
  assert.deepEqual((m.getRow(1).values as any[]).slice(1), ["Deposit No", "Deposit To Account", "Date", "Received From", "Linked Transaction Type", "Line Amount", "Currency Code", "Linked Transaction Number", "dattt", "File Amount", "Discount", "Order Total Tax Amount", "QBSalesTax", "TaxDiff"]);
  const r = (ws: ExcelJS.Worksheet, n: number) => (ws.getRow(n).values as any[]).slice(1).map(val);
  assert.deepEqual(r(m, 2), ["AN0909", "Test Account", "09/09/2026", "A B (a@b.com)", "SalesReceipt", 65.01, "USD", "Woo Order#73199", "09/09/2026", 65.01, 0, 5.02, 5.02, 0]);   // fixed: after
  assert.deepEqual(r(b, 2), ["AN0909", "Test Account", "09/09/2026", "A B (a@b.com)", "SalesReceipt", 65.93, "USD", "Woo Order#73199", "09/09/2026", 65.01, 0.92, 5.02, 5.94, -0.92]); // before
  assert.deepEqual(r(m, 3).slice(4, 14), ["RefundReceipt", -62.12, "USD", "Woo Refund#73187", "09/09/2026", -68.55, 6.43, -5.22, -6.13, 0.91]);       // refund signs
  assert.deepEqual(r(m, 4).slice(5, 14), ["", "USD", "Woo Order#999", "09/09/2026", 10, "", 1, "", ""]);                                              // not found: QBO blank
  assert.deepEqual(r(m, 5).slice(5, 14), [100, "USD", "Woo Order#5", "09/09/2026", 100, 0, 8, 0, 8]);                                                // rolled back: still the old values
  assert.equal(((m.getCell("K2").value as any).formula), "F2-J2"); assert.equal(((m.getCell("N2").value as any).formula), "L2-M2");
  console.log("output workbook tests passed");
})();
console.log("logic tests passed");

// --- parser on the real downloads, when their paths are given
for (const [env, want] of [["DL_0909", { rows: 52, skipped: 15 }], ["DL_0908", { rows: 63, skipped: 17 }]] as const) {
  const p = process.env[env];
  if (!p) { console.log(`(skipped parser test: set ${env})`); continue; }
  const b = fs.readFileSync(p); const s = parseSettlement(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  assert.deepEqual({ rows: s.rows.length, skipped: s.skipped.length }, want, env);
  console.log(env, "parsed:", s.rows.length, "rows,", s.skipped.length, "skipped", s.counts);
}
