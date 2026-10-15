// Builds the Excel report from the results the page already holds.
import * as XLSX from "xlsx";
import type { Verdict } from "@/lib/recon";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { results } = (await req.json()) as { results: (Verdict & { final?: string; error?: string; after?: Verdict })[] };
  const rows = results.map((r) => {
    const nf = r.status === "Not found"; // not in QuickBooks: leave QBO figures and TaxDiff blank, change nothing
    return {
    "Order": r.order, "Type": r.type === "sale" ? "Sales receipt" : "Refund", "Customer": r.customer,
    "Status": r.final || r.status, "In deposit": r.inDeposit ? "Yes" : "",
    "Settlement amount": r.settle, "Woo total": r.wooTotal, "QBO total (before)": nf ? "" : r.qboTotal, "QBO total (after)": r.after?.qboTotal ?? "",
    "Woo tax": r.wooTax, "QBO tax (before)": nf ? "" : r.qboTax, "QBO tax (after)": r.after?.qboTax ?? "",
    "TaxDiff (before)": nf ? "" : r.taxDiff, "TaxDiff (after)": r.after ? r.after.taxDiff : "", "Tax scenario": r.scenario,
    "Planned changes": r.final === "Skipped" ? "Skipped by the user. Nothing was changed in QuickBooks." : [r.plan.tax ? (r.plan.tax.mode === "remove" ? "Remove tax" : `Set total tax to ${r.plan.tax.total.toFixed(2)}`) : "", ...r.plan.addLines.map((a) => `Add ${a.itemName} ${a.amount.toFixed(2)}`)].filter(Boolean).join("; "),
    "Differences": r.issues.map((i) => `${i.field}: Woo ${i.woo}, QBO ${i.qbo}`).join("; "),
    "Needs review because": r.blockers.join("; "), "Error": r.error || "",
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Reconciliation");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="reconciliation-report.xlsx"' } });
}
