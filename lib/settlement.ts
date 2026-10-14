// Reads the Authorize.net settlement download (xlsx/csv) and keeps only settled sales and credited refunds.
import * as XLSX from "xlsx";

export type Row = { order: string; type: "sale" | "refund"; amount: number; fileTax: number; fileFreight: number; txnId: string; customer: string };
export type Skipped = { txnId: string; order: string; status: string; amount: number; reason: string };
export type Settlement = { rows: Row[]; skipped: Skipped[]; problems: string[]; counts: Record<string, number> };

const num = (v: unknown) => {
  const x = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
};

export function parseSettlement(buf: ArrayBuffer): Settlement {
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "", raw: false });
  const problems: string[] = [];
  if (!data.length) return { rows: [], skipped: [], problems: ["The file has no rows."], counts: {} };
  const need = ["Transaction ID", "Transaction Status", "Transaction Type", "Settlement Amount", "Invoice Number"];
  const missing = need.filter((h) => !(h in data[0]));
  if (missing.length) return { rows: [], skipped: [], problems: [`This does not look like an Authorize.net settlement download. Missing columns: ${missing.join(", ")}.`], counts: {} };

  const rows: Row[] = [], skipped: Skipped[] = [], counts: Record<string, number> = {};
  const seen = new Map<string, number>();
  for (const d of data) {
    const txnId = String(d["Transaction ID"] || "").trim();
    if (!txnId) continue;
    const status = String(d["Transaction Status"] || "").trim();
    counts[status] = (counts[status] || 0) + 1;
    const order = String(d["Invoice Number"] || "").trim();
    const amount = num(d["Settlement Amount"]);
    const sale = status === "Settled Successfully";
    const refund = status === "Credited";
    if (!sale && !refund) { skipped.push({ txnId, order, status, amount, reason: `${status || "No status"}: not settled` }); continue; }
    if (!/^\d+$/.test(order)) { skipped.push({ txnId, order, status, amount, reason: "No valid order number in Invoice Number" }); continue; }
    const type = refund ? "refund" : "sale";
    const key = `${type}:${order}:${amount}`;
    if (seen.has(key)) { problems.push(`Order ${order} appears more than once with the same ${type} amount (${amount.toFixed(2)}). Check the file.`); continue; }
    seen.set(key, 1);
    rows.push({
      order, type, amount, txnId, fileTax: num(d["L2 - Tax"]), fileFreight: num(d["L2 - Freight"]),
      customer: [d["Customer First Name"], d["Customer Last Name"]].filter(Boolean).join(" "),
    });
  }
  return { rows, skipped, problems, counts };
}
