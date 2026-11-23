// Apply the tax fix for one row. The plan is re-computed here from fresh QuickBooks data (the browser's copy is never trusted),
// the receipt is saved, re-read from QuickBooks and compared with the file again. If it does not match, the receipt is put back.
import { handler } from "@/lib/route";
import { checkRow, parseRow } from "@/lib/run";
import { applyFix, assertWritable, reread, restore, explainFailure, qbLink, type FixPlan } from "@/lib/qb";
import { reconcile, verified } from "@/lib/recon";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request) => {
  assertWritable();
  const row = parseRow(await req.json());
  const { verdict: before, doc } = await checkRow(row);
  if (before.status !== "Needs fix" || !doc || !before.plan.tax) return { before, after: before, verified: false, applied: false, message: `Nothing was changed: status is “${before.status}”.` };

  const link = qbLink(row.type, doc.id);
  const target = before.plan.tax;
  const taxToEnter = target.mode === "set" ? target.total : undefined;
  // QuickBooks's API cannot be trusted to set an exact tax amount (it ignored it on test receipts, and a rollback then moved the tax).
  // So an exact amount is never written here: the person is told the figure to enter with "Edit sales tax".
  // Written automatically: removing the tax, and making the shipping line non-taxable when that alone gives the file's tax.
  if (target.mode === "set" && !before.plan.untaxShipping)
    return { before, after: before, verified: false, applied: false, manualTax: true, taxToEnter, link, tried: [],
      message: `Nothing was changed. QuickBooks cannot take an exact tax amount from this tool. Open the receipt, choose Edit sales tax (see the math), enter ${taxToEnter!.toFixed(2)}, reason Other, Apply override, Save. Then check this row again.` };
  const attempts: FixPlan[] = [];
  if (before.plan.untaxShipping) attempts.push({ untaxItemId: before.plan.untaxShipping.itemId });
  else attempts.push({ tax: target });

  const original = JSON.parse(JSON.stringify(doc.raw)); // kept so the receipt can be put back
  let cur = doc, wrote = false, lastReason = "", rolledBack = true, rollbackError = "";
  const tried: string[] = []; // what QuickBooks actually held after each try, to show the person
  for (const plan of attempts) {
    try { await applyFix(cur, plan); wrote = true; }
    catch (e) { lastReason = explainFailure(e); continue; } // QuickBooks refused: nothing was written
    const again = await reread(row.type, doc.id);
    const after = reconcile(row, again);
    if (verified(after)) return { before, after, verified: true, applied: true, link, message: "Saved and verified: QuickBooks tax and total now match the file." };
    lastReason = explainFailure(null, { taxStillWrong: Math.abs(after.taxDiff) > 0.01, totalStillWrong: Math.abs(after.totalDiff) > 0.01 });
    tried.push(`${plan.untaxItemId ? "shipping non-taxable" : plan.style === "total" ? "tax amount only" : "tax amount with tax line"}: QuickBooks showed tax ${again.tax.toFixed(2)}, total ${again.total.toFixed(2)} (needed ${after.fileTax.toFixed(2)} and ${after.settle.toFixed(2)})`);
    try { // put the receipt back and check that it really is back
      cur = await restore(row.type, doc.id, original);
      rolledBack = Math.abs(cur.total - doc.total) < 0.011 && Math.abs(cur.tax - doc.tax) < 0.011;
      if (!rolledBack) rollbackError = `After the rollback QuickBooks shows total ${cur.total} and tax ${cur.tax}, not the original ${doc.total} and ${doc.tax}.`;
    } catch (e) { rolledBack = false; rollbackError = e instanceof Error ? e.message : String(e); break; }
  }

  if (!rolledBack)
    return { before, after: before, verified: false, applied: true, reason: lastReason, rolledBack: false, rollbackError, link, tried, message: `Not fixed: ${lastReason} The receipt could NOT be put back automatically (${rollbackError}). Open it in QuickBooks and check it. What happened: ${tried.join("; ")}.` };
  if (target.mode === "set")
    return { before, after: before, verified: false, applied: false, manualTax: true, taxToEnter, reason: lastReason, rolledBack: wrote, link,
      tried, message: `QuickBooks would not take this tax through the API (${lastReason}; ${tried.join("; ")}). Nothing was left changed. Open the receipt, choose Edit sales tax, enter ${taxToEnter!.toFixed(2)}, Apply override, Save. Then check this row again.` };
  return { before, after: before, verified: false, applied: false, refused: true, reason: lastReason, rolledBack: wrote, link, tried, message: `Not fixed: ${lastReason}${wrote ? " The receipt was put back to how it was." : " Nothing was changed."}` };
});
