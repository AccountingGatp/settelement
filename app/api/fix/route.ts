// Apply the approved fix for one row. The plan is re-computed here from fresh data (the browser's copy is never trusted),
// the receipt is saved, re-read from QuickBooks and compared with Woo again.
import { handler } from "@/lib/route";
import { checkRow, parseRow } from "@/lib/run";
import { applyFix, assertWritable, reread, listItems } from "@/lib/qb";
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

  await applyFix(doc, {
    tax: before.plan.tax,
    addLines: before.plan.addLines.map((a) => ({ itemId: a.itemId, qty: a.qty, rate: a.rate, amount: a.amount, description: a.description })),
  });
  const [woo, again, items] = await Promise.all([getOrder(row.order), reread(row.type, doc.id), listItems(true)]);
  const after = reconcile(row, woo, again, items);
  const ok = verified(after);
  await kvSet(`audit:${new Date().toISOString()}:${row.type}:${row.order}`, { before, after, ok });
  return { before, after, verified: ok, applied: true, message: ok ? "Saved and verified: QuickBooks now matches Woo." : "Saved, but QuickBooks still differs from Woo. See the details." };
});
