// The comparison logic. Pure functions: no network, so it can be tested with plain numbers.
// The settlement file is the reference: its amount and its tax (column "Order Total Tax Amount") are what QuickBooks must show.
// Refund principal can also be corrected using the company’s designated adjustment item.
import type { QDoc } from "./qb";
import type { Row } from "./settlement";

const cents = (n: number) => Math.round(n * 100);
export const sameMoney = (a: number, b: number) => cents(a) === cents(b);
const difference = (a: number, b: number) => (cents(a) - cents(b)) / 100;

export type Issue = { field: string; file: string; qbo: string; diff: number; note: string; auto: boolean };
export type TaxPlan = { mode: "set"; total: number } | { mode: "remove" };
export type RefundItem = { id: string; name: string };
export type Plan = { adjustment?: RefundItem & { amount: number }; tax?: TaxPlan; preview?: { taxFrom: number; taxTo: number; totalFrom: number; totalTo: number } };
export type Status = "Matched" | "Needs fix" | "Pending review" | "Line amount differs" | "Not found";
export type Scenario = "A" | "B" | "C" | "D" | "-";

export type Verdict = {
  order: string; type: "sale" | "refund"; customer: string; date?: string; depositNo?: string; receivedFrom?: string; qboCustomer?: string; link?: string; docNumber?: string; taxToEnter?: number; status: Status; scenario: Scenario;
  receiptId?: string; checkedAt?: string; lineAmount?: number; lineDiff?: number;
  settle: number; fileTax: number | null; qboTotal: number; qboTax: number;
  taxDiff: number | null; totalDiff: number; inDeposit: boolean;
  issues: Issue[]; plan: Plan; blockers: string[]; notes: string[];
};

const blank = (row: Row): Verdict => ({
  order: row.order, type: row.type, customer: row.customer, date: row.date, depositNo: row.depositNo, receivedFrom: row.receivedFrom, status: "Pending review", scenario: "-",
  lineAmount: row.lineAmount, settle: Math.abs(row.amount), fileTax: row.fileTax === null ? null : Math.abs(row.fileTax), qboTotal: 0, qboTax: 0, taxDiff: null, totalDiff: 0, inDeposit: false,
  issues: [], plan: {}, blockers: [], notes: [],
});

/** A: file has no tax but QuickBooks does. B: both have tax, they differ. C: equal. D: file has tax, QuickBooks none. */
export function scenarioOf(fileTax: number, qboTax: number): Scenario {
  if (sameMoney(fileTax, qboTax)) return "C";
  if (fileTax === 0) return "A";
  if (qboTax === 0) return "D";
  return "B";
}

export function reconcile(row: Row, q: QDoc | null, refundItem?: RefundItem): Verdict {
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
  v.receiptId = q.id;
  if (row.lineAmount !== undefined) v.lineDiff = difference(row.lineAmount, q.total);
  if (q.inDeposit) v.notes.push("In deposit");

  // A zero from the legacy workbook can confirm a match. It cannot authorize a write.
  if (row.type === "refund" && v.fileTax === null && row.legacyRefundZeroTax &&
      !row.reviewReason && v.totalDiff === 0 && sameMoney(q.tax, 0)) {
    v.fileTax = 0;
  }
  if (v.fileTax === null) {
    v.blockers.push("The file does not identify the refunded tax. Use a settlement export with refund tax or supply Refund Tax Amount in the workbook.");
    return v;
  }
  const fileTax = v.fileTax;
  v.taxDiff = difference(fileTax, q.tax);
  v.scenario = scenarioOf(fileTax, q.tax);
  if (row.reviewReason) {
    v.blockers.push(row.reviewReason);
    return v;
  }
  if (v.taxDiff === 0 && v.totalDiff === 0) {
    v.status = "Matched";
    return v;
  }

  const fileSubtotal = difference(v.settle, fileTax);
  const qbSubtotal = difference(q.total, q.tax);
  const principalDiff = difference(fileSubtotal, qbSubtotal);
  if (principalDiff !== 0) {
    const auto = row.type === "refund" && !!refundItem && fileSubtotal >= 0;
    v.issues.push({ field: "Amount before tax", file: fileSubtotal.toFixed(2), qbo: qbSubtotal.toFixed(2), diff: principalDiff, note: auto ? `Post the difference to ${refundItem.name}.` : "Review the pre-tax receipt amount.", auto });
    if (!auto) {
      v.blockers.push(row.type === "refund" && fileSubtotal >= 0
        ? `The pre-tax refund differs by ${principalDiff.toFixed(2)}. A QuickBooks refund adjustment item is required to post it automatically.`
        : `The file amount before tax is ${fileSubtotal.toFixed(2)} and QuickBooks shows ${qbSubtotal.toFixed(2)}. Review the receipt lines before changing the tax.`);
      return v;
    }
    v.plan.adjustment = { ...refundItem, amount: principalDiff };
  }

  if (v.taxDiff !== 0) {
    v.plan.tax = v.scenario === "A" ? { mode: "remove" } : { mode: "set", total: fileTax };
    const note = "Set total tax directly to the file's tax.";
    v.issues.push({ field: "Tax", file: fileTax.toFixed(2), qbo: q.tax.toFixed(2), diff: v.taxDiff, note, auto: true });
  }
  v.plan.preview = { taxFrom: q.tax, taxTo: fileTax, totalFrom: q.total, totalTo: v.settle };
  v.status = "Needs fix";
  return v;
}

/** After a fix is saved and re-read: did QuickBooks end up matching the file? */
export function verified(after: Verdict): boolean {
  return after.status === "Matched" && after.taxDiff === 0 && after.totalDiff === 0;
}
