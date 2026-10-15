// The comparison logic. Pure functions: no network, so it can be tested with plain numbers.
// WooCommerce is the reference. A row is "Needs fix" only when EVERY difference has an automatic fix.
import type { WOrder, WLine } from "./woo";
import type { QDoc, QItem, QLine } from "./qb";
import type { Row } from "./settlement";

export const TOL = 0.01;
const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) <= TOL + 1e-9;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type Issue = { field: string; woo: string; qbo: string; diff: number; note: string; auto: boolean };
export type AddLine = { itemId: string; itemName: string; qty: number; rate: number; amount: number; description: string };
export type TaxPlan = { mode: "set"; total: number } | { mode: "remove" };
export type Plan = { tax?: TaxPlan; addLines: AddLine[] };
export type Status = "Matched" | "Needs fix" | "Pending review" | "Not found";
export type Scenario = "A" | "B" | "C" | "D" | "-";

export type Verdict = {
  order: string; type: "sale" | "refund"; customer: string; status: Status; scenario: Scenario;
  settle: number; wooTotal: number; wooTax: number; qboTotal: number; qboTax: number;
  taxDiff: number; totalDiff: number; inDeposit: boolean;
  issues: Issue[]; plan: Plan; blockers: string[]; notes: string[];
};

const blank = (row: Row): Verdict => ({
  order: row.order, type: row.type, customer: row.customer, status: "Pending review", scenario: "-",
  settle: row.amount, wooTotal: 0, wooTax: 0, qboTotal: 0, qboTax: 0, taxDiff: 0, totalDiff: 0, inDeposit: false,
  issues: [], plan: { addLines: [] }, blockers: [], notes: [],
});

export function scenarioOf(wooTax: number, qboTax: number): Scenario {
  if (near(wooTax, qboTax)) return "C";
  if (wooTax <= TOL && qboTax > TOL) return "A";
  if (wooTax > TOL && qboTax <= TOL) return "D";
  return "B";
}

function findItem(items: QItem[], l: WLine): QItem | undefined {
  const act = items.filter((i) => i.active);
  if (l.sku) {
    const bySku = act.find((i) => i.sku && i.sku.toLowerCase() === l.sku.toLowerCase());
    if (bySku) return bySku;
  }
  const n = norm(l.name);
  return act.find((i) => norm(i.name) === n);
}

export function reconcile(row: Row, woo: WOrder | null, q: QDoc | null, items: QItem[]): Verdict {
  const v = blank(row);
  if (!woo) { v.status = "Not found"; v.blockers.push("Order not found in WooCommerce."); return v; }
  if (!q) {
    // Not in QuickBooks: nothing is created or changed. Keep the row as it is and show Woo's figures for review.
    v.status = "Not found"; v.settle = Math.abs(row.amount);
    if (row.type === "sale") { v.wooTotal = woo.total; v.wooTax = woo.tax; }
    v.blockers.push(`${row.type === "sale" ? "Sales receipt" : "Refund receipt"} not found in QuickBooks. Nothing was changed; review by hand.`);
    return v;
  }

  // --- Woo side figures (refunds: use the matching Woo refund)
  let wooTotal = woo.total, wooTax = woo.tax, taxKnown = true;
  const settle = Math.abs(row.amount);
  if (row.type === "refund") {
    const exact = woo.refunds.filter((x) => near(x.total, settle));
    const pick = exact.length === 1 ? exact[0] : exact.length === 0 && woo.refunds.length === 1 ? woo.refunds[0] : null;
    if (!pick) { v.blockers.push(exact.length > 1 ? "More than one Woo refund has this amount." : "Could not match a Woo refund to this credit."); wooTotal = 0; wooTax = 0; taxKnown = false; }
    else { wooTotal = pick.total; wooTax = pick.tax; taxKnown = pick.hasBreakdown; if (!taxKnown) v.notes.push("The Woo refund has no line breakdown, so its tax is unknown."); }
  }
  v.settle = settle; v.wooTotal = wooTotal; v.wooTax = wooTax; v.qboTotal = q.total; v.qboTax = q.tax; v.inDeposit = q.inDeposit;
  v.totalDiff = r2(wooTotal - q.total);
  if (taxKnown) { v.taxDiff = r2(wooTax - q.tax); v.scenario = scenarioOf(wooTax, q.tax); }
  if (q.inDeposit) v.notes.push("In deposit");

  if (wooTotal && !near(wooTotal, settle)) v.blockers.push(`Woo total ${wooTotal.toFixed(2)} differs from the settlement amount ${settle.toFixed(2)}.`);

  // --- non-tax lines (sales only; refunds are compared by total and tax)
  const preTaxDiff = r2((wooTotal - wooTax) - (q.total - q.tax));
  let explained = 0;
  if (row.type === "sale") {
    const qlines = q.lines.filter((l) => l.kind === "item");
    const used = new Set<number>();
    const take = (pred: (l: QLine) => boolean) => { const i = qlines.findIndex((l, ix) => !used.has(ix) && pred(l)); if (i >= 0) used.add(i); return i >= 0 ? qlines[i] : undefined; };
    const compareAmounts = woo.discount <= TOL;
    if (!compareAmounts) v.notes.push("Order has a discount: line amounts are not compared.");
    for (const w of woo.lines) {
      if (w.amount <= TOL && w.kind !== "item") continue; // free shipping / zero fees
      const m = (w.sku && take((l) => !!l.sku && l.sku.toLowerCase() === w.sku.toLowerCase())) || take((l) => norm(l.name) === norm(w.name)) || take((l) => near(l.amount, w.amount));
      if (m) {
        if (compareAmounts && !near(m.amount, w.amount)) {
          v.issues.push({ field: `Line “${w.name}”`, woo: w.amount.toFixed(2), qbo: m.amount.toFixed(2), diff: r2(w.amount - m.amount), note: "Amount differs. Review by hand.", auto: false });
          v.blockers.push(`Line “${w.name}” amount differs.`);
          explained += r2(w.amount - m.amount);
        }
        continue;
      }
      const item = findItem(items, w);
      const note = item ? `Add to QuickBooks as “${item.name}”.` : "No matching QuickBooks item.";
      v.issues.push({ field: `Missing line “${w.name}”`, woo: w.amount.toFixed(2), qbo: "-", diff: w.amount, note, auto: !!item });
      explained += w.amount;
      if (item) v.plan.addLines.push({ itemId: item.id, itemName: item.name, qty: w.qty, rate: r2(w.amount / (w.qty || 1)), amount: w.amount, description: w.name });
      else v.blockers.push(`No QuickBooks item found for “${w.name}”.`);
    }
    qlines.forEach((l, ix) => {
      if (used.has(ix) || l.amount <= TOL) return;
      v.issues.push({ field: `Extra line “${l.name || "line"}”`, woo: "-", qbo: l.amount.toFixed(2), diff: -l.amount, note: "In QuickBooks but not in Woo. Review by hand.", auto: false });
      v.blockers.push(`QuickBooks has a line “${l.name || "line"}” that Woo does not.`);
      explained -= l.amount;
    });
    const qDisc = q.lines.filter((l) => l.kind === "discount").reduce((s, l) => s + Math.abs(l.amount), 0);
    if (!near(woo.discount, qDisc)) {
      v.issues.push({ field: "Discount", woo: woo.discount.toFixed(2), qbo: qDisc.toFixed(2), diff: r2(qDisc - woo.discount), note: "Discount differs. Review by hand.", auto: false });
      v.blockers.push("Discount differs.");
      explained += r2(qDisc - woo.discount);
    }
  }
  // anything the lines do not explain stops the automatic fix
  if (!near(preTaxDiff, explained) && !(row.type === "refund" && !taxKnown)) {
    v.issues.push({ field: "Amount before tax", woo: r2(wooTotal - wooTax).toFixed(2), qbo: r2(q.total - q.tax).toFixed(2), diff: r2(preTaxDiff - explained), note: "Difference that no line explains. Review by hand.", auto: false });
    v.blockers.push(`${Math.abs(r2(preTaxDiff - explained)).toFixed(2)} of the difference is not explained by any line.`);
  }

  // --- tax
  if (taxKnown && v.scenario !== "C" && v.scenario !== "-") {
    v.plan.tax = v.scenario === "A" ? { mode: "remove" } : { mode: "set", total: wooTax };
    const what = v.scenario === "A" ? "Remove tax (Woo has none)" : v.scenario === "D" ? "Add tax to match Woo" : "Set total tax to match Woo (QBO is higher, often tax on shipping)";
    v.issues.push({ field: "Tax", woo: wooTax.toFixed(2), qbo: q.tax.toFixed(2), diff: v.taxDiff, note: what, auto: true });
  }

  // --- verdict
  const clean = v.issues.length === 0 && near(v.totalDiff, 0) && (!taxKnown || near(v.taxDiff, 0)) && v.blockers.length === 0;
  v.status = clean ? "Matched" : v.blockers.length ? "Pending review" : "Needs fix";
  return v;
}

/** After a fix is saved and re-read: did QuickBooks end up matching Woo? */
export function verified(after: Verdict): boolean {
  return after.status === "Matched";
}
