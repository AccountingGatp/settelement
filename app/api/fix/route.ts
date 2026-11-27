import { handler } from "@/lib/route";
import { checkRow, parseRow } from "@/lib/run";
import { applyTaxStep, assertWritable, reread, restore, sameReceiptLines, explainFailure, qbLink, type FixStep, type QDoc } from "@/lib/qb";
import { reconcile, sameMoney, verified } from "@/lib/recon";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request) => {
  assertWritable();
  const row = parseRow(await req.json());
  const { verdict: before, doc } = await checkRow(row);
  if (before.status !== "Needs fix" || !doc || before.fileTax === null) {
    return { before, after: before, verified: false, applied: false, message: `Current QuickBooks status is “${before.status}”.` };
  }

  const originalDoc = doc;
  const receiptId = doc.id;
  const link = qbLink(row.type, receiptId);
  const tax = before.fileTax;
  const adjustment = before.plan.adjustment;
  const shipping = before.plan.untaxShipping;
  const steps: FixStep[] = [];
  if (process.env.TAX_OVERRIDE_API !== "no") {
    if (!adjustment) steps.push({ kind: "total", tax });
    steps.push({ kind: "lines", tax });
    if (doc.raw.TxnTaxDetail?.TaxLine?.length) steps.push({ kind: "override", tax });
  } else if (adjustment && !before.plan.tax) {
    steps.push({ kind: "lines", tax });
  }
  if (shipping) steps.push({ kind: "shipping", tax, shippingId: shipping.itemId });
  if (before.plan.tax?.mode === "remove") steps.push({ kind: "remove", tax });

  let current = doc;
  let observed = doc;
  let saved = false;
  let rollbackError = "";
  let compensated = false;
  const tried: string[] = [];
  const view = (receipt: QDoc) => ({ ...reconcile(row, receipt, adjustment), link });
  const adjustedAmount = (receipt: QDoc) => receipt.lines
    .filter((line) => line.itemId === adjustment?.id && line.taxCode === "NON")
    .reduce((sum, line) => sum + line.amount, 0);
  const correct = (after: ReturnType<typeof view>) => verified(after) && (!adjustment ||
    sameMoney(adjustedAmount(observed) - adjustedAmount(originalDoc), adjustment.amount));

  async function readCurrent() {
    observed = await reread(row.type, receiptId);
    if (observed.syncToken !== current.syncToken) throw new Error("The receipt changed during the update.");
    return observed;
  }

  for (const step of steps) {
    try {
      current = await applyTaxStep(current, doc, step, adjustment);
      saved = true;
      let after = view(await readCurrent());
      const diff = after.taxDiff ?? 0;
      if (!compensated && !correct(after) && tax > 0 && Math.abs(diff) === 0.01 && diff === after.totalDiff) {
        compensated = true;
        current = await applyTaxStep(current, doc, { ...step, tax: Math.round((tax + diff) * 100) / 100 }, adjustment);
        after = view(await readCurrent());
      }
      if (correct(after)) return { before, after, verified: true, applied: true, link, message: "Tax and total saved and verified." };
      tried.push(`${step.kind} left tax ${observed.tax.toFixed(2)} and total ${observed.total.toFixed(2)}`);
    } catch (error) {
      tried.push(`${step.kind}: ${explainFailure(error)}`);
      try { await readCurrent(); }
      catch (readError) { rollbackError = explainFailure(readError); break; }
    }
  }

  const original = (receipt: QDoc) => sameMoney(receipt.tax, doc.tax) && sameMoney(receipt.total, doc.total) && sameReceiptLines(receipt, doc);
  if (!rollbackError && saved && !original(observed)) {
    try {
      // Try all compatible corrections before restoring. QBO can recalculate a receipt on any line write.
      for (const exactDetail of [false, true]) {
        current = await restore(current, doc, exactDetail);
        if (original(await readCurrent())) break;
      }
      if (!original(observed)) rollbackError = "QuickBooks did not confirm the original receipt values.";
    } catch (error) {
      rollbackError = explainFailure(error);
    }
  }

  return {
    before, after: view(observed), verified: false, applied: saved || !!rollbackError, failed: true, link, tried,
    reason: rollbackError || tried.join(" · ") || "No compatible tax update is enabled.",
    message: rollbackError
      ? "Check this receipt in QuickBooks. The other receipts can continue."
      : "QuickBooks did not save the exact settlement amounts.",
    taxToEnter: tax,
  };
});
