// The comparison logic. Pure functions: no network, so it can be tested with plain numbers.
// The settlement file is the reference: its amount and its tax (column "Order Total Tax Amount") are what QuickBooks must show.
// Only the sales tax is corrected. A row is "Needs fix" only when the tax is the whole difference.
import type { QDoc } from "./qb";
import type { Row } from "./settlement";

export const TOL = 0.01;
const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number, t = TOL) => Math.abs(a - b) <= t + 1e-9;

export type Issue = { field: string; file: string; qbo: string; diff: number; note: string; auto: boolean };
export type TaxPlan = { mode: "set"; total: number } | { mode: "remove" };
export type Plan = { tax?: TaxPlan; untaxShipping?: { itemId: string; name: string } };
export type Status = "Matched" | "Needs fix" | "Pending review" | "Not found";
export type Scenario = "A" | "B" | "C" | "D" | "-";

export type Verdict = {
  order: string; type: "sale" | "refund"; customer: string; date?: string; depositNo?: string; receivedFrom?: string; qboCustomer?: string; link?: string; taxToEnter?: number; status: Status; scenario: Scenario;
  settle: number; fileTax: number; qboTotal: number; qboTax: number;
  taxDiff: number; totalDiff: number; inDeposit: boolean;
  issues: Issue[]; plan: Plan; blockers: string[]; notes: string[];
};

const blank = (row: Row): Verdict => ({
  order: row.order, type: row.type, customer: row.customer, date: row.date, depositNo: row.depositNo, receivedFrom: row.receivedFrom, status: "Pending review", scenario: "-",
  settle: Math.abs(row.amount), fileTax: Math.abs(row.fileTax || 0), qboTotal: 0, qboTax: 0, taxDiff: 0, totalDiff: 0, inDeposit: false,
  issues: [], plan: {}, blockers: [], notes: [],
});

/** A: file has no tax but QuickBooks does. B: both have tax, they differ. C: equal. D: file has tax, QuickBooks none. */
export function scenarioOf(fileTax: number, qboTax: number): Scenario {
  if (near(fileTax, qboTax)) return "C";
  if (fileTax <= TOL && qboTax > TOL) return "A";
  if (fileTax > TOL && qboTax <= TOL) return "D";
  return "B";
}

/** QuickBooks taxed the shipping line: if making only that line non-taxable brings the tax to the file's figure, return that line. */
function shippingToUntax(q: QDoc, fileTax: number): { itemId: string; name: string } | undefined {
  const ship = q.lines.find((l) => l.kind === "item" && !!l.itemId && !!l.taxCode && l.taxCode !== "NON" && /ship|freight|deliver/i.test(l.name));
  if (!ship) return undefined;
  const taxable = q.lines.filter((l) => l.taxCode && l.taxCode !== "NON");
  const base = taxable.reduce((t, l) => t + (l.kind === "discount" ? -l.amount : l.kind === "item" ? l.amount : 0), 0);
  if (base <= TOL) return undefined;
  const shipTax = r2(ship.amount * (q.tax / base));
  return near(r2(q.tax - shipTax), fileTax, 0.02) ? { itemId: ship.itemId, name: ship.name || "Shipping" } : undefined;
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
  v.qboTotal = q.total; v.qboTax = q.tax; v.inDeposit = q.inDeposit;
  v.taxDiff = r2(v.fileTax - q.tax);
  v.totalDiff = r2(v.settle - q.total);
  v.scenario = scenarioOf(v.fileTax, q.tax);
  if (q.inDeposit) v.notes.push("In deposit");

  const pre = r2(q.total - q.tax);            // what QuickBooks holds before tax
  const expected = r2(pre + v.fileTax);       // what the total will be once the tax equals the file's tax

  if (row.type === "refund") {
    // the file's tax column belongs to the original order, so a refund is never changed automatically
    if (!near(v.taxDiff, 0) || !near(v.totalDiff, 0)) {
      if (!near(v.taxDiff, 0)) v.issues.push({ field: "Tax", file: v.fileTax.toFixed(2), qbo: q.tax.toFixed(2), diff: v.taxDiff, note: "Refunds are not changed automatically.", auto: false });
      if (!near(v.totalDiff, 0)) v.issues.push({ field: "Amount", file: v.settle.toFixed(2), qbo: q.total.toFixed(2), diff: v.totalDiff, note: "Refunds are not changed automatically.", auto: false });
      v.blockers.push("Refund receipts are not changed automatically. Review by hand.");
    }
  } else if (!near(expected, v.settle)) {
    // the difference is more than tax (a missing or wrong line, for example): this tool only corrects tax
    v.issues.push({ field: "Amount before tax", file: r2(v.settle - v.fileTax).toFixed(2), qbo: pre.toFixed(2), diff: r2(v.settle - expected), note: "Not a tax difference. Nothing was changed.", auto: false });
    v.blockers.push(`QuickBooks holds ${pre.toFixed(2)} before tax. With the file's tax ${v.fileTax.toFixed(2)} that makes ${expected.toFixed(2)}, but the file amount is ${v.settle.toFixed(2)}. The ${Math.abs(r2(v.settle - expected)).toFixed(2)} difference is not tax (for example a missing or wrong line), so review it by hand.`);
  } else if (v.scenario !== "C") {
    v.plan.tax = v.scenario === "A" ? { mode: "remove" } : { mode: "set", total: v.fileTax };
    let note = v.scenario === "A" ? "File has no tax: remove the tax (untick Taxable on every line)." : v.scenario === "D" ? "Add tax to match the file." : "Set total tax to the file's tax.";
    if (v.scenario === "B" && q.tax > v.fileTax + TOL) {
      const ship = shippingToUntax(q, v.fileTax);
      if (ship) { v.plan.untaxShipping = ship; note = `QuickBooks taxed shipping: make “${ship.name}” non-taxable so the tax becomes the file's tax.`; }
    }
    v.issues.push({ field: "Tax", file: v.fileTax.toFixed(2), qbo: q.tax.toFixed(2), diff: v.taxDiff, note, auto: true });
  }

  const clean = v.issues.length === 0 && near(v.totalDiff, 0) && near(v.taxDiff, 0) && v.blockers.length === 0;
  v.status = clean ? "Matched" : v.blockers.length ? "Pending review" : "Needs fix";
  return v;
}

/** After a fix is saved and re-read: did QuickBooks end up matching the file? */
export function verified(after: Verdict): boolean {
  return after.status === "Matched";
}
