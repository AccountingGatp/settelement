// Reads the Authorize.net settlement download (xlsx/csv) and keeps only settled sales and credited refunds.
import * as XLSX from "xlsx";

export type Row = { order: string; type: "sale" | "refund"; amount: number; fileTax: number; fileFreight: number; txnId: string; customer: string };
export type Skipped = { txnId: string; order: string; status: string; amount: number; reason: string };
export type Settlement = { rows: Row[]; skipped: Skipped[]; problems: string[]; counts: Record<string, number> };

const num = (v: unknown) => {
  const x = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
};

/** The team's output workbook ("main" sheet: Linked Transaction Number, File Amount ...). Only the order numbers, type and
 *  settlement amount are used from it; every other figure is read fresh from Woo and QuickBooks. */
function parseOutputSheet(data: Record<string, unknown>[]): Settlement {
  const rows: Row[] = [], problems: string[] = [], seen = new Set<string>();
  for (const d of data) {
    const link = String(d["Linked Transaction Number"] || "").trim();
    const order = (link.match(/(\d+)\s*$/) || [])[1];
    if (!order) continue;
    const t = String(d["Linked Transaction Type"] || "").toLowerCase();
    const type: "sale" | "refund" = /refund|credit/.test(t) || /refund/i.test(link) ? "refund" : "sale";
    const amount = num(d["File Amount"] !== "" && d["File Amount"] != null ? d["File Amount"] : d["Line Amount"]);
    const k = `${type}:${order}:${amount}`;
    if (seen.has(k)) { problems.push(`Order ${order} appears more than once with the same ${type} amount (${amount.toFixed(2)}). Check the file.`); continue; }
    seen.add(k);
    rows.push({ order, type, amount: type === "refund" ? -Math.abs(amount) : amount, fileTax: num(d["Order Total Tax Amount"]), fileFreight: 0, txnId: String(d["Deposit No"] || ""), customer: String(d["Received From"] || "").replace(/\s*\(.*\)\s*$/, "") });
  }
  return { rows, skipped: [], problems, counts: { "Rows in the output workbook": rows.length } };
}

export function parseSettlement(buf: ArrayBuffer): Settlement {
  const wb = XLSX.read(buf, { type: "array" });
  const sheetRows = (name: string) => XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: "", raw: false });
  // output workbook: use its "main" sheet (or the first sheet that has the columns)
  for (const name of ["main", ...wb.SheetNames]) {
    if (!wb.Sheets[name]) continue;
    const r = sheetRows(name);
    if (r.length && "Linked Transaction Number" in r[0] && ("File Amount" in r[0] || "Line Amount" in r[0])) return parseOutputSheet(r);
  }
  const data = sheetRows(wb.SheetNames[0]);
  const problems: string[] = [];
  if (!data.length) return { rows: [], skipped: [], problems: ["The file has no rows."], counts: {} };
  const need = ["Transaction ID", "Transaction Status", "Transaction Type", "Settlement Amount", "Invoice Number"];
  const missing = need.filter((h) => !(h in data[0]));
  if (missing.length) return { rows: [], skipped: [], problems: [`This does not look like an Authorize.net settlement download or the output workbook. Missing columns: ${missing.join(", ")}.`], counts: {} };

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
