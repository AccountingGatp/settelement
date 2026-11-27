// Recompute the plan from QuickBooks, save it and verify the persisted figures to the cent.
import { handler } from "@/lib/route";
import { checkRow, parseRow } from "@/lib/run";
import { applyTaxStep, assertWritable, recalc, reread, restore, explainFailure, qbLink, type FixStep, type QDoc } from "@/lib/qb";
import { reconcile, sameMoney, verified } from "@/lib/recon";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request) => {
  assertWritable();
  const row = parseRow(await req.json());
  const { verdict: before, doc } = await checkRow(row);
  if (before.status !== "Needs fix" || !doc || !before.plan.tax) {
    return { before, after: before, verified: false, applied: false, message: `Current QuickBooks status is “${before.status}”.` };
  }

  const link = qbLink(row.type, doc.id);
  const target = before.plan.tax.mode === "remove" ? 0 : before.plan.tax.total;
  const shipping = before.plan.untaxShipping;
  const steps: FixStep[] = [];
  if (target === 0) steps.push({ kind: "remove" });
  if (shipping) steps.push({ kind: "shipping", itemId: shipping.itemId });
  if (process.env.TAX_OVERRIDE_API !== "no") {
    if (doc.raw.TxnTaxDetail?.TaxLine?.length) steps.push({ kind: "override", tax: target });
    steps.push({ kind: "total", tax: target });
  }

  let current = doc;
  let lastReason = "";
  let rolledBack = false;
  const tried: string[] = [];
  const readCurrent = () => reread(row.type, doc.id);
  const view = (receipt: QDoc) => ({ ...reconcile(row, receipt), link });
  async function verifyVersion() {
    const observed = await readCurrent();
    if (observed.syncToken !== current.syncToken) throw new Error("The receipt changed during verification.");
    return observed;
  }

  for (const step of steps) {
    const initial = current;
    let saved = false;
    try {
      current = await applyTaxStep(current, step);
      saved = true;
      let observed = await verifyVersion();
      let after = view(observed);
      if (!verified(after)) {
        current = await recalc(current);
        observed = await verifyVersion();
        after = view(observed);
      }
      if (step.kind === "override" && after.status === "Needs fix" && Math.abs(after.taxDiff ?? 0) === 0.01) {
        // The first save may leave one cent after QuickBooks recalculates the tax lines.
        current = await applyTaxStep(observed, step);
        observed = await verifyVersion();
        after = view(observed);
        if (!verified(after)) {
          current = await recalc(current);
          observed = await verifyVersion();
          after = view(observed);
        }
      }
      if (verified(after)) return { before, after, verified: true, applied: true, link, message: "Saved and verified. QuickBooks tax and total match the file." };
      lastReason = explainFailure(null, { taxStillWrong: after.taxDiff !== 0, totalStillWrong: after.totalDiff !== 0 });
      tried.push(`${step.kind}: QuickBooks showed tax ${observed.tax.toFixed(2)} and total ${observed.total.toFixed(2)}.`);
    } catch (error) {
      lastReason = explainFailure(error);
      tried.push(`${step.kind}: ${lastReason}`);
    }

    try {
      const observed = await readCurrent();
      if (observed.syncToken !== current.syncToken) throw new Error("The receipt changed during the fix. Check its current values in QuickBooks.");
      if (!saved) {
        current = observed;
        continue;
      }
      current = await restore(current, initial);
      let restored = await verifyVersion();
      const originalFigures = (receipt: QDoc) => sameMoney(receipt.tax, initial.tax) && sameMoney(receipt.total, initial.total);
      if (!originalFigures(restored)) {
        current = await recalc(current);
        restored = await verifyVersion();
      }
      const lineCodes = (receipt: QDoc) => receipt.lines.filter((line) => line.kind === "item").map(({ itemId, taxCode }) => [itemId, taxCode]);
      if (!originalFigures(restored) || JSON.stringify(lineCodes(restored)) !== JSON.stringify(lineCodes(initial))) {
        throw new Error("QuickBooks did not confirm the original figures and item tax codes after restoring the receipt.");
      }
      current = restored;
      rolledBack = true;
    } catch (error) {
      const observed = await readCurrent().catch(() => null);
      return {
        before, after: observed ? view(observed) : before, verified: false, applied: true, rolledBack: false, link, tried,
        reason: lastReason, message: `${explainFailure(error)} Open the receipt in QuickBooks before running more fixes.`,
      };
    }
  }

  const reason = lastReason || "An automatic tax override is unavailable for this receipt.";
  return {
    before, after: view(current), verified: false, applied: false, manualTax: true, taxToEnter: target, rolledBack, link, tried, reason,
    message: `Enter ${target.toFixed(2)} in Edit sales tax in QuickBooks, save the receipt, and check this row again.`,
  };
});
