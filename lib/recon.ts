// The comparison logic. Pure functions: no network, so it can be tested with plain numbers.
// The settlement file is the reference: its amount and its tax (column "Order Total Tax Amount") are what QuickBooks must show.
// Only the sales tax is corrected. A row is "Needs fix" only when the tax is the whole difference.
import type { QDoc } from "./qb";
import type { Row } from "./settlement";

const cents = (n: number) => Math.round(n * 100);
export const sameMoney = (a: number, b: number) => cents(a) === cents(b);
const difference = (a: number, b: number) => (cents(a) - cents(b)) / 100;

export type Issue = { field: string; file: string; qbo: string; diff: number; note: string; auto: boolean };
export type TaxPlan = { mode: "set"; total: number } | { mode: "remove" };
export type Plan = { tax?: TaxPlan; untaxShipping?: { itemId: string; name: string }; preview?: { taxFrom: number; taxTo: number; totalFrom: number; totalTo: number } };
export type Status = "Matched" | "Needs fix" | "Pending review" | "Not found";
export type Scenario = "A" | "B" | "C" | "D" | "-";

export type Verdict = {
  order: string; type: "sale" | "refund"; customer: string; date?: string; depositNo?: string; receivedFrom?: string; qboCustomer?: string; link?: string; docNumber?: string; taxToEnter?: number; status: Status; scenario: Scenario;
  settle: number; fileTax: number | null; qboTotal: number; qboTax: number;
  taxDiff: number | null; totalDiff: number; inDeposit: boolean;
  issues: Issue[]; plan: Plan; blockers: string[]; notes: string[];
};

const blank = (row: Row): Verdict => ({
  order: row.order, type: row.type, customer: row.customer, date: row.date, depositNo: row.depositNo, receivedFrom: row.receivedFrom, status: "Pending review", scenario: "-",
  settle: Math.abs(row.amount), fileTax: row.fileTax === null ? null : Math.abs(row.fileTax), qboTotal: 0, qboTax: 0, taxDiff: null, totalDiff: 0, inDeposit: false,
  issues: [], plan: {}, blockers: [], notes: [],
});

/** A: file has no tax but QuickBooks does. B: both have tax, they differ. C: equal. D: file has tax, QuickBooks none. */
export function scenarioOf(fileTax: number, qboTax: number): Scenario {
  if (sameMoney(fileTax, qboTax)) return "C";
  if (fileTax === 0) return "A";
  if (qboTax === 0) return "D";
  return "B";
}

/** QuickBooks probably taxed the shipping line: the surplus tax is small and no bigger than a tax rate on the shipping charge.
 *  Return that line so the fix can make it non-taxable (the fix is verified afterwards and undone if it does not give the file's tax).
 *  Shipping may be the QuickBooks shipping field (item SHIPPING_ITEM_ID), which often carries no tax code at all. */
function shippingToUntax(q: QDoc, fileTax: number): { itemId: string; name: string } | undefined {
  const ship = q.lines.find((l) => l.kind === "item" && !!l.itemId && l.taxCode !== "NON" && (l.itemId === "SHIPPING_ITEM_ID" || /ship|freight|deliver/i.test(l.name)));
  if (!ship || ship.amount <= 0) return undefined;
  const surplus = difference(q.tax, fileTax);
  return surplus > 0 && surplus <= ship.amount * 0.2 ? { itemId: ship.itemId, name: ship.name || "Shipping" } : undefined;
}

export function reconcile(row: Row, q: QDoc | null): Verdict {
  const v = blank(row);
  if (!q) {
    // Not in QuickBooks: nothing is created or changed. The row stays as it is for review.
    v.status = "Not found";
    v.blockers.push(`${row.type === "sale" ? "Sales receipt" : "Refund receipt"} not found in QuickBooks. Nothing was changed; review by hand.`);
    return v;
  }
  v.qboCustomer = q.customer; // the customer name QuickBooks holds; the output file's "Received From" uses it
  v.qboTotal = q.total; v.qboTax = q.tax; v.inDeposit = q.inDeposit; v.docNumber = q.docNumber;
  v.totalDiff = difference(v.settle, q.total);
  if (q.inDeposit) v.notes.push("In deposit");

  if (v.fileTax === null) {
    v.blockers.push("The file does not identify the refunded tax. Use a settlement export with refund tax or supply Refund Tax Amount in the workbook.");
    return v;
  }
  const fileTax = v.fileTax;
  v.taxDiff = difference(fileTax, q.tax);
  v.scenario = scenarioOf(fileTax, q.tax);
  if (v.taxDiff === 0 && v.totalDiff === 0) {
    v.status = "Matched";
    return v;
  }
  if (row.reviewReason) {
    v.blockers.push(row.reviewReason);
    return v;
  }

  const fileSubtotal = difference(v.settle, fileTax);
  const qbSubtotal = difference(q.total, q.tax);
  if (!sameMoney(fileSubtotal, qbSubtotal)) {
    v.issues.push({ field: "Amount before tax", file: fileSubtotal.toFixed(2), qbo: qbSubtotal.toFixed(2), diff: difference(fileSubtotal, qbSubtotal), note: "Review the amount before tax.", auto: false });
    v.blockers.push(`The file amount before tax is ${fileSubtotal.toFixed(2)} and QuickBooks shows ${qbSubtotal.toFixed(2)}. Review the receipt lines before changing the tax.`);
    return v;
  }

  v.plan.tax = v.scenario === "A" ? { mode: "remove" } : { mode: "set", total: fileTax };
  let note = v.scenario === "A" ? "Remove the tax." : "Set total tax to the file's tax.";
  if (v.scenario === "B" && q.tax > fileTax) {
    const ship = shippingToUntax(q, fileTax);
    if (ship) { v.plan.untaxShipping = ship; note = `Make “${ship.name}” non-taxable and verify the tax.`; }
  }
  v.plan.preview = { taxFrom: q.tax, taxTo: fileTax, totalFrom: q.total, totalTo: v.settle };
  v.issues.push({ field: "Tax", file: fileTax.toFixed(2), qbo: q.tax.toFixed(2), diff: v.taxDiff, note, auto: true });
  v.status = "Needs fix";
  return v;
}

/** After a fix is saved and re-read: did QuickBooks end up matching the file? */
export function verified(after: Verdict): boolean {
  return after.status === "Matched" && after.taxDiff === 0 && after.totalDiff === 0;
}
