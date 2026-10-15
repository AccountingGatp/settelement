// Apply the approved fix for one row. The plan is re-computed here from fresh data (the browser's copy is never trusted),
// the receipt is saved, re-read from QuickBooks and compared with Woo again.
import { handler } from "@/lib/route";
import { checkRow, parseRow } from "@/lib/run";
import { applyFix, assertWritable, reread, listItems, restore, explainFailure } from "@/lib/qb";
import { reconcile, verified } from "@/lib/recon";
import { getOrder } from "@/lib/woo";
import { kvLock, kvSet } from "@/lib/store";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request) => {
  assertWritable();
  const row = parseRow(await req.json());
  if (!(await kvLock(`fix:${row.type}:${row.order}`, 60))) throw new Error("This order is already being fixed. Wait a minute and check again.");
  const { verdict: before, doc } = await checkRow(row, true);
  if (before.status !== "Needs fix" || !doc) return { before, after: before, verified: false, applied: false, message: `Nothing was changed: status is “${before.status}”.` };

  const original = JSON.parse(JSON.stringify(doc.raw)); // kept so the receipt can be put back
  try {
    await applyFix(doc, {
      tax: before.plan.tax,
      replaceLines: before.plan.replaceLines?.map((a) => ({ itemId: a.itemId, qty: a.qty, rate: a.rate, amount: a.amount, description: a.description, discount: a.discount })),
      addLines: before.plan.addLines.map((a) => ({ itemId: a.itemId, qty: a.qty, rate: a.rate, amount: a.amount, description: a.description })),
    });
  } catch (e) {
    // QuickBooks refused the save, so nothing was written
    const reason = explainFailure(e);
    await kvSet(`audit:${new Date().toISOString()}:${row.type}:${row.order}`, { before, refused: reason });
    return { before, after: before, verified: false, applied: false, refused: true, reason, message: `Nothing was changed. QuickBooks refused the save: ${reason}` };
  }
  const [woo, again, items] = await Promise.all([getOrder(row.order), reread(row.type, doc.id), listItems(true)]);
  const after = reconcile(row, woo, again, items);
  const ok = verified(after);
  if (ok) {
    await kvSet(`audit:${new Date().toISOString()}:${row.type}:${row.order}`, { before, after, ok });
    return { before, after, verified: true, applied: true, message: "Saved and verified: QuickBooks now matches Woo." };
  }

  // Saved but still different from Woo: put the receipt back to how it was and check that it really is back.
  const reason = explainFailure(null, { taxStillWrong: Math.abs(after.taxDiff) > 0.01, totalStillWrong: Math.abs(after.totalDiff) > 0.01, linesStillWrong: after.issues.length > 0 });
  let rolledBack = false, rollbackError = "";
  try {
    const back = await restore(row.type, doc.id, original);
    rolledBack = Math.abs(back.total - doc.total) < 0.011 && Math.abs(back.tax - doc.tax) < 0.011;
    if (!rolledBack) rollbackError = `After the rollback QuickBooks shows total ${back.total} and tax ${back.tax}, not the original ${doc.total} and ${doc.tax}.`;
  } catch (e) { rollbackError = e instanceof Error ? e.message : String(e); }
  await kvSet(`audit:${new Date().toISOString()}:${row.type}:${row.order}`, { before, after, ok, reason, rolledBack, rollbackError });
  return {
    before, after, verified: false, applied: true, reason, rolledBack, rollbackError,
    message: rolledBack ? `Not fixed: ${reason} The receipt was put back to how it was.` : `Not fixed: ${reason} The receipt could NOT be put back automatically (${rollbackError}). Open it in QuickBooks and check it.`,
  };
});
