// Read only. Shows how QuickBooks stores the tax of one receipt (no customer details), so tax overrides can be done through the API correctly.
// Open in the browser while logged in:  /api/taxdetail?order=85153
import { handler } from "@/lib/route";
import { findDoc } from "@/lib/qb";
export const dynamic = "force-dynamic";
export const GET = handler(async (req: Request) => {
  const order = new URL(req.url).searchParams.get("order") || "";
  if (!/^\d+$/.test(order)) throw new Error("Add ?order=<order number> to the address.");
  const d = await findDoc("sale", order);
  if (!d) throw new Error("Receipt not found.");
  const r = d.raw;
  return {
    docNumber: d.docNumber, total: r.TotalAmt, applyTaxAfterDiscount: r.ApplyTaxAfterDiscount, globalTaxCalculation: r.GlobalTaxCalculation,
    txnTaxDetail: r.TxnTaxDetail,
    lines: (r.Line || []).map((l: any) => ({ detailType: l.DetailType, amount: l.Amount, item: l.SalesItemLineDetail?.ItemRef, taxCode: l.SalesItemLineDetail?.TaxCodeRef || l.DiscountLineDetail?.TaxCodeRef, discount: l.DiscountLineDetail ? { percentBased: l.DiscountLineDetail.PercentBased, percent: l.DiscountLineDetail.DiscountPercent } : undefined })),
  };
});
