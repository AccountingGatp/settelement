import { handler } from "@/lib/route";
import { checkRow, parseRow } from "@/lib/run";
import { applyTaxStep, assertWritable, reread, restore, sameReceiptLines, explainFailure, qbLink, QuickBooksError, type FixStep, type QDoc } from "@/lib/qb";
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

  const original = doc;
  const link = qbLink(row.type, original.id);
  const tax = before.fileTax;
  const adjustment = before.plan.adjustment;
  const shipping = before.plan.untaxShipping;
  const steps: FixStep[] = [];
  if (process.env.TAX_OVERRIDE_API !== "no") {
    if (!adjustment) steps.push({ kind: "total", tax });
    steps.push({ kind: "lines", tax });
    if (original.raw.TxnTaxDetail?.TaxLine?.length) steps.push({ kind: "override", tax });
  } else if (adjustment && !before.plan.tax) {
    steps.push({ kind: "lines", tax });
  }
  if (shipping) steps.push({ kind: "shipping", tax, shippingId: shipping.itemId });
  if (before.plan.tax?.mode === "remove") steps.push({ kind: "remove", tax });

  const tried: string[] = [];
  let observed = original;
  let current = original;
  let changed = false;
  let unconfirmed = false;
  let lastIssue = "";
  let compensated = false;
  const view = (receipt: QDoc) => ({ ...reconcile(row, receipt, adjustment), link });
  const adjustmentTotal = (receipt: QDoc) => receipt.lines
    .filter((line) => line.itemId === adjustment?.id && line.taxCode === "NON")
    .reduce((sum, line) => sum + line.amount, 0);
  const originalValues = (receipt: QDoc) => sameMoney(receipt.tax, original.tax) &&
    sameMoney(receipt.total, original.total) && sameReceiptLines(receipt, original);

  async function readCurrent() {
    observed = await reread(row.type, original.id);
    if (String(observed.syncToken) !== String(current.syncToken)) throw new Error("QuickBooks returned a different receipt version. Check the current receipt.");
  }

  function recordError(step: string, error: unknown) {
    const trace = error instanceof QuickBooksError ? [error.code, error.traceId].filter(Boolean).join(" / ") : "";
    lastIssue = explainFailure(error);
    tried.push(`${step}: ${lastIssue}${trace ? ` [${trace}]` : ""}`);
    console.warn("settlement.quickbooks.failure", { step, type: row.type, code: error instanceof QuickBooksError ? error.code : undefined, trace });
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let roundingDifference = 0;
    try {
      current = await applyTaxStep(current, original, step, adjustment);
      await readCurrent();
      const after = view(observed);
      if (verified(after) && (!adjustment || sameMoney(adjustmentTotal(observed) - adjustmentTotal(original), adjustment.amount))) {
        return { before, after, verified: true, applied: true, link, message: "Tax and total saved and verified." };
      }
      if (tax > 0 && after.taxDiff === after.totalDiff && Math.abs(after.totalDiff) === 0.01) roundingDifference = after.totalDiff;
      lastIssue = `QuickBooks returned tax ${observed.tax.toFixed(2)} and total ${observed.total.toFixed(2)}.`;
      tried.push(`${step.kind}: ${lastIssue}`);
    } catch (error) {
      recordError(step.kind, error);
      try { await readCurrent(); }
      catch (readError) { recordError("verify", readError); unconfirmed = true; break; }
    }

    // Only try another update if QuickBooks still has the original figures and lines.
    if (!originalValues(observed)) {
      changed = true;
      try {
        current = await restore(current, original);
        await readCurrent();
        unconfirmed = !originalValues(observed);
      } catch (error) {
        recordError("restore", error);
        unconfirmed = true;
        // Never use a fresh SyncToken to overwrite a concurrent edit.
        try { observed = await reread(row.type, original.id); } catch { /* Keep the last known figures. */ }
      }
      if (unconfirmed) break;
    }
    if (roundingDifference && !compensated) {
      compensated = true;
      steps.splice(i + 1, 0, { ...step, tax: Math.round((tax + roundingDifference) * 100) / 100 });
    }
  }

  if (tried.length) {
    console.warn("settlement.quickbooks.unverified", { type: row.type, attempts: tried.length, unconfirmed });
  }
  const reason = lastIssue || "No compatible update is enabled.";
  return {
    before, after: view(observed), verified: false, applied: changed || unconfirmed, failed: true, link, tried,
    reason,
    message: unconfirmed ? "QuickBooks did not confirm the original receipt. Check its current values."
      : `QuickBooks could not verify the correction. ${reason}`,
    taxToEnter: adjustment ? undefined : tax,
  };
});
