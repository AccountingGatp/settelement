// Reads the Authorize.net settlement download (xlsx/csv) and keeps only settled sales and credited refunds.
import * as XLSX from "xlsx";

export type Row = { order: string; type: "sale" | "refund"; amount: number; fileTax: number | null; legacyRefundZeroTax?: boolean; fileFreight: number; txnId: string; customer: string; date?: string; depositNo?: string; receivedFrom?: string; docNumber?: string; prefix?: string; reviewReason?: string };
export type Skipped = { txnId: string; order: string; status: string; amount: number; reason: string };
export type Settlement = { rows: Row[]; skipped: Skipped[]; problems: string[]; counts: Record<string, number> };

const MON: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** "09-Sep-2026 06:23:52 PM PDT" -> "09/09/2026" */
function settleDate(v: unknown): string {
  const m = String(v || "").match(/(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})/);
  return m ? `${MON[m[2].toLowerCase()] || "01"}/${m[1].padStart(2, "0")}/${m[3]}` : "";
}

const taxAmount = (value: unknown): number | null => {
  const text = String(value ?? "").trim();
  const cleaned = text.replace(/[$,()\s]/g, "");
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned) && Number.isFinite(Number(cleaned))
    ? Math.round(Math.abs(Number(cleaned)) * 100) / 100
    : null;
};

function flagRepeatedOrders(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.type}:${row.order}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) row.reviewReason = "Multiple settlement rows share this order and receipt type. Confirm which QuickBooks receipt belongs to each transaction.";
  }
}

const num = (v: unknown) => {
  const x = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
};

/** The team's output workbook ("main" sheet: Linked Transaction Number, File Amount ...). The order number, type, file amount and
 *  the file's tax ("Order Total Tax Amount") are used from it; QuickBooks figures are always read fresh. */
function parseOutputSheet(data: Record<string, unknown>[]): Settlement {
  const rows: Row[] = [], problems: string[] = [], seen = new Set<string>();
  for (const d of data) {
    const link = String(d["Linked Transaction Number"] || "").trim();
    const order = (link.match(/(\d+)\s*$/) || [])[1];
    if (!order) continue;
    const t = String(d["Linked Transaction Type"] || "").toLowerCase();
    const type: "sale" | "refund" = /refund|credit/.test(t) || /refund/i.test(link) ? "refund" : "sale";
    const amount = num(d["File Amount"] !== "" && d["File Amount"] != null ? d["File Amount"] : d["Line Amount"]);
    const k = `${type}:${link}:${Math.abs(amount)}:${d["Deposit No"]}:${d["Date"]}`;
    if (seen.has(k)) { problems.push(`Order ${order} appears more than once with the same ${type} amount (${amount.toFixed(2)}). Check the file.`); continue; }
    seen.add(k);
    const legacyRefundTax = d["Order Total Tax Amount"];
    // The signed tax on the team's refund rows is a refund figure. An unsigned legacy value may be the original sale's tax.
    const refundTax = taxAmount(d["Refund Tax Amount"]) ??
      (/^\s*(?:-|\(|\$-)/.test(String(legacyRefundTax ?? "")) ? taxAmount(legacyRefundTax) : null);
    const legacyRefundZeroTax = type === "refund" && refundTax === null &&
      (legacyRefundTax === 0 || /^\s*0(?:\.0+)?\s*$/.test(String(legacyRefundTax ?? "")));
    rows.push({ order, type, legacyRefundZeroTax, amount: type === "refund" ? -Math.abs(amount) : amount, fileTax: type === "refund" ? refundTax : num(d["Order Total Tax Amount"]), docNumber: link, fileFreight: 0, txnId: String(d["Deposit No"] || ""), customer: String(d["Received From"] || "").replace(/\s*\(.*\)\s*$/, ""),
      date: String(d["Date"] || ""), depositNo: String(d["Deposit No"] || ""), receivedFrom: String(d["Received From"] || "") });
  }
  flagRepeatedOrders(rows);
  const sales = new Map(rows.filter((row) => row.type === "sale" && !row.reviewReason).map((row) => [row.order, row]));
  for (const row of rows) {
    if (row.type !== "refund" || row.fileTax !== null || row.reviewReason) continue;
    const sale = sales.get(row.order);
    if (sale && sale.amount > 0 && sale.amount === Math.abs(row.amount)) row.fileTax = sale.fileTax;
  }
  return { rows, skipped: [], problems, counts: { "Rows in the output workbook": rows.length } };
}

export function parseSettlement(buf: ArrayBuffer): Settlement {
  const wb = XLSX.read(buf, { type: "array" });
  const sheetRows = (name: string) => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown> & { __rowNum__: number }>(sheet, { defval: "", raw: false });
    if (!sheet["!ref"] || !rows.length) return rows;
    const { s, e } = XLSX.utils.decode_range(sheet["!ref"]);
    // Accounting formats can display a stored zero as a dash. Preserve numeric tax cells.
    for (let c = s.c; c <= e.c; c++) {
      const header = sheet[XLSX.utils.encode_cell({ r: s.r, c })]?.v;
      if (header !== "Order Total Tax Amount" && header !== "Refund Tax Amount" && header !== "L2 - Tax") continue;
      for (const row of rows) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row.__rowNum__, c })];
        if (cell?.t === "n") row[header] = cell.v;
      }
    }
    return rows;
  };
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
  const seen = new Set<string>();
  for (const d of data) {
    const txnId = String(d["Transaction ID"] || "").trim();
    if (!txnId) continue;
    const status = String(d["Transaction Status"] || "").trim();
    counts[status] = (counts[status] || 0) + 1;
    const order = String(d["Invoice Number"] || "").trim();
    const amount = num(d["Settlement Amount"]);
    const settled = /^settled successfully$/i.test(status);
    const refund = /^credited$/i.test(status) || (settled && /refund|credit/i.test(String(d["Transaction Type"])));
    const sale = settled && !refund;
    if (!sale && !refund) { skipped.push({ txnId, order, status, amount, reason: `${status || "No status"}: not settled` }); continue; }
    if (!/^\d+$/.test(order)) { skipped.push({ txnId, order, status, amount, reason: "No valid order number in Invoice Number" }); continue; }
    const type = refund ? "refund" : "sale";
    const key = txnId;
    if (seen.has(key)) { problems.push(`Order ${order} appears more than once with the same ${type} amount (${amount.toFixed(2)}). Check the file.`); continue; }
    seen.add(key);
    rows.push({
      order, type, amount, txnId, fileTax: refund ? taxAmount(d["L2 - Tax"]) : num(d["L2 - Tax"]), fileFreight: num(d["L2 - Freight"]),
      customer: [d["Customer First Name"], d["Customer Last Name"]].filter(Boolean).join(" "),
      ...(() => {
        const date = settleDate(d["Settlement Date/Time"]);
        const name = [d["Customer First Name"], d["Customer Last Name"]].filter(Boolean).join(" ");
        const email = String(d["Email"] || "").trim();
        return { date, depositNo: date ? "AN" + date.slice(0, 2) + date.slice(3, 5) : "", receivedFrom: name + (email ? ` (${email})` : "") };
      })(),
    });
  }
  flagRepeatedOrders(rows);
  return { rows, skipped, problems, counts };
}
