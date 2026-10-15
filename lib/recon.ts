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
export type AddLine = { itemId: string; itemName: string; qty: number; rate: number; amount: number; description: string; discount?: boolean };
export type TaxPlan = { mode: "set"; total: number } | { mode: "remove" };
export type Plan = { tax?: TaxPlan; addLines: AddLine[]; replaceLines?: AddLine[] };
export type Status = "Matched" | "Needs fix" | "Pending review" | "Not found";
export type Scenario = "A" | "B" | "C" | "D" | "-";

export type Verdict = {
  order: string; type: "sale" | "refund"; customer: string; date?: string; depositNo?: string; receivedFrom?: string; qboCustomer?: string; status: Status; scenario: Scenario;
  settle: number; wooTotal: number; wooTax: number; qboTotal: number; qboTax: number;
  taxDiff: number; totalDiff: number; inDeposit: boolean;
  issues: Issue[]; plan: Plan; blockers: string[]; notes: string[];
};

const blank = (row: Row): Verdict => ({
  order: row.order, type: row.type, customer: row.customer, date: row.date, depositNo: row.depositNo, receivedFrom: row.receivedFrom, status: "Pending review", scenario: "-",
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
  v.qboCustomer = q.customer; // the customer name QuickBooks holds; the output file's "Received From" uses it
  v.settle = settle; v.wooTotal = wooTotal; v.wooTax = wooTax; v.qboTotal = q.total; v.qboTax = q.tax; v.inDeposit = q.inDeposit;
  v.totalDiff = r2(wooTotal - q.total);
  if (taxKnown) { v.taxDiff = r2(wooTax - q.tax); v.scenario = scenarioOf(wooTax, q.tax); }
  if (q.inDeposit) v.notes.push("In deposit");

  if (wooTotal && !near(wooTotal, settle)) v.blockers.push(`Woo total ${wooTotal.toFixed(2)} differs from the settlement amount ${settle.toFixed(2)}.`);

  // --- non-tax lines. Woo is the truth: the receipt must end up with Woo's lines and Woo's amount before tax.
  const preTaxDiff = r2((wooTotal - wooTax) - (q.total - q.tax));
  if (row.type === "sale") {
    const wNet = r2(wooTotal - wooTax);
    const qlines = q.lines.filter((l) => l.kind === "item");
    const wl = woo.lines.filter((l) => Math.abs(l.amount) > TOL || (l.kind === "item" && l.amount !== 0));
    const hasDiscount = woo.discount > TOL || wl.some((l) => l.amount < -TOL);
    if (hasDiscount) v.notes.push("Order has a discount: lines are compared by their total before tax.");
    const missing: WLine[] = [], mismatch: { w: WLine; m: QLine }[] = [];
    const used = new Set<number>();
    const take = (pred: (l: QLine) => boolean) => { const i = qlines.findIndex((l, ix) => !used.has(ix) && pred(l)); if (i >= 0) used.add(i); return i >= 0 ? qlines[i] : undefined; };
    if (!hasDiscount) {
      for (const w of wl) {
        const m = (w.sku && take((l) => !!l.sku && l.sku.toLowerCase() === w.sku.toLowerCase())) || take((l) => norm(l.name) === norm(w.name)) || take((l) => near(l.amount, w.amount));
        if (!m) missing.push(w); else if (!near(m.amount, w.amount)) mismatch.push({ w, m });
      }
    }
    const extra = hasDiscount ? [] : qlines.filter((l, ix) => !used.has(ix) && l.amount > TOL);
    const lineIssues = missing.length + mismatch.length + extra.length > 0;

    if (lineIssues || !near(preTaxDiff, 0)) {
      const missSum = r2(missing.reduce((t, w) => t + w.amount, 0));
      const onlyMissing = !hasDiscount && missing.length > 0 && !mismatch.length && !extra.length && near(preTaxDiff, missSum);
      const itemFor = (w: WLine, m?: QLine) => (m?.itemId ? { id: m.itemId, name: m.name } : findItem(items, w));
      if (onlyMissing) {
        for (const w of missing) {
          const item = findItem(items, w);
          v.issues.push({ field: `Missing line “${w.name}”`, woo: w.amount.toFixed(2), qbo: "-", diff: w.amount, note: item ? `Add to QuickBooks as “${item.name}”.` : "No matching QuickBooks item.", auto: !!item });
          if (item) v.plan.addLines.push({ itemId: item.id, itemName: item.name, qty: w.qty, rate: r2(w.amount / (w.qty || 1)), amount: w.amount, description: w.name });
          else v.blockers.push(`No QuickBooks item found for “${w.name}”.`);
        }
      } else {
        for (const w of missing) v.issues.push({ field: `Missing line “${w.name}”`, woo: w.amount.toFixed(2), qbo: "-", diff: w.amount, note: "Will be added when the lines are rebuilt from Woo.", auto: true });
        for (const x of mismatch) v.issues.push({ field: `Line “${x.w.name}”`, woo: x.w.amount.toFixed(2), qbo: x.m.amount.toFixed(2), diff: r2(x.w.amount - x.m.amount), note: "Amount differs. Will be set to Woo's.", auto: true });
        for (const l of extra) v.issues.push({ field: `Extra line “${l.name || "line"}”`, woo: "-", qbo: l.amount.toFixed(2), diff: -l.amount, note: "In QuickBooks but not in Woo. Will be removed.", auto: true });
        if (!lineIssues) v.issues.push({ field: "Amount before tax", woo: wNet.toFixed(2), qbo: r2(q.total - q.tax).toFixed(2), diff: preTaxDiff, note: "Lines will be rebuilt to match Woo's amount.", auto: true });

        // rebuild: every Woo line, in Woo's amounts. Reuse the QuickBooks item already on the receipt when it matches.
        const usedR = new Set<number>();
        const takeR = (pred: (l: QLine) => boolean) => { const i = qlines.findIndex((l, ix) => !usedR.has(ix) && pred(l)); if (i >= 0) usedR.add(i); return i >= 0 ? qlines[i] : undefined; };
        const target: AddLine[] = [];
        let ok = true;
        for (const w of wl) {
          if (w.amount < -TOL) { target.push({ itemId: "", itemName: "Discount", qty: 1, rate: r2(-w.amount), amount: r2(-w.amount), description: w.name, discount: true }); continue; }
          const m = (w.sku && takeR((l) => !!l.sku && l.sku.toLowerCase() === w.sku.toLowerCase())) || takeR((l) => norm(l.name) === norm(w.name)) || (hasDiscount ? undefined : takeR((l) => near(l.amount, w.amount)));
          const it = itemFor(w, m);
          if (!it) { ok = false; v.blockers.push(`No QuickBooks item found for “${w.name}”.`); continue; }
          const qty = w.qty || 1, rate = r2(w.amount / qty);
          const exact = Math.abs(rate * qty - w.amount) < 0.005;
          target.push({ itemId: it.id, itemName: it.name, qty: exact ? qty : 1, rate: exact ? rate : w.amount, amount: w.amount, description: w.name });
        }
        const sum = r2(target.reduce((t, l) => t + (l.discount ? -l.amount : l.amount), 0));
        if (ok && !near(sum, wNet)) { ok = false; v.blockers.push(`Woo's lines add up to ${sum.toFixed(2)} before tax, but Woo's total less tax is ${wNet.toFixed(2)}.`); }
        if (ok) v.plan.replaceLines = target;
      }
    }
  }
  if (row.type === "refund" && !near(preTaxDiff, 0) && taxKnown) {
    v.issues.push({ field: "Amount before tax", woo: r2(wooTotal - wooTax).toFixed(2), qbo: r2(q.total - q.tax).toFixed(2), diff: preTaxDiff, note: "Refund amounts differ. Review by hand.", auto: false });
    v.blockers.push(`${Math.abs(preTaxDiff).toFixed(2)} of the refund difference is not explained by tax.`);
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
