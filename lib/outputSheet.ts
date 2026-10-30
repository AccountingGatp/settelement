// Builds the output workbook in the same layout the team already uses:
//   main           = after the fixes (what QuickBooks holds now)
//   Sales_Authnet  = before the fixes (what QuickBooks held when the check ran)
//   Changes        = what was done or planned for each row, and why a row needs a person
// Column L is the file's tax (the figure QuickBooks must show); M is the tax QuickBooks holds; N = L - M.
import ExcelJS from "exceljs";
import type { Verdict } from "./recon";

export type OutRow = Verdict & { final?: string; after?: Verdict; reason?: string; rolledBack?: boolean; error?: string };

const HEAD = ["Deposit No", "Deposit To Account", "Date", "Received From", "Linked Transaction Type", "Line Amount", "Currency Code", "Linked Transaction Number", "dattt", "File Amount", "Discount", "Order Total Tax Amount", "QBSalesTax", "TaxDiff"];
const NUM = '#,##0.00;\\(#,##0.00\\);"-"';
const WIDTH = [10.875, 26.875, 11.875, 42.875, 22.875, 12.875, 8.875, 24.875, 11.875, 12.875, 10.875, 16.875, 12.875, 10.875];
const r2 = (n: number) => Math.round(n * 100) / 100;

function figures(v: OutRow, when: "before" | "after") {
  const sign = v.type === "refund" ? -1 : 1;
  const nf = v.status === "Not found";
  const useAfter = when === "after" && !!v.after && !v.rolledBack;
  const total = nf ? null : sign * (useAfter ? v.after!.qboTotal : v.qboTotal);
  const qbTax = nf ? null : sign * (useAfter ? v.after!.qboTax : v.qboTax);
  const fileTax = sign * v.fileTax;
  return { sign, file: sign * Math.abs(v.settle), total, qbTax, fileTax };
}

function addSheet(wb: ExcelJS.Workbook, name: string, rows: OutRow[], when: "before" | "after", account: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(HEAD).font = { bold: true };
  WIDTH.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  rows.forEach((v, i) => {
    const f = figures(v, when), n = i + 2;
    const doc = (v.type === "sale" ? "Woo Order#" : "Woo Refund#") + v.order;
    const row = ws.addRow([
      v.depositNo || "", account, v.date || "", v.qboCustomer || v.receivedFrom || v.customer || "", v.type === "sale" ? "SalesReceipt" : "RefundReceipt",
      f.total ?? "", "USD", doc, v.date || "", f.file,
      f.total == null ? "" : { formula: `F${n}-J${n}`, result: r2(f.total - f.file) },
      f.fileTax, f.qbTax ?? "",
      f.qbTax == null ? "" : { formula: `L${n}-M${n}`, result: r2(f.fileTax - f.qbTax) },
    ]);
    [6, 10, 11, 12, 13, 14].forEach((c) => (row.getCell(c).numFmt = NUM));
    const off = f.total == null || Math.abs(f.total - f.file) > 0.005 || (f.qbTax != null && Math.abs(f.fileTax - f.qbTax) > 0.005);
    if (off) row.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7E7" } }));
  });
}

function changeText(v: OutRow): string {
  const p = v.plan;
  if (!p.tax) return "";
  if (p.tax.mode === "remove") return "Remove tax (all lines non-taxable)";
  return p.untaxShipping ? `Make ${p.untaxShipping.name} non-taxable (tax should become ${p.tax.total.toFixed(2)})` : `Set total tax to ${p.tax.total.toFixed(2)}`;
}

export async function buildOutput(rows: OutRow[], account = process.env.DEPOSIT_ACCOUNT || "First Citizen Clearing Account"): Promise<{ buffer: Buffer; filename: string }> {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true; // Excel works the formulas out when the file is opened
  addSheet(wb, "main", rows, "after", account);
  addSheet(wb, "Sales_Authnet", rows, "before", account);

  const ws = wb.addWorksheet("Changes", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(["Order", "Type", "Difference type", "Result", "Tax scenario", "In deposit", "Changed or planned", "Reason / needs review because"]).font = { bold: true };
  [10, 10, 22, 22, 12, 11, 70, 70].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  for (const v of rows) {
    const t = v.issues.some((i) => i.field === "Tax"), o = v.issues.some((i) => i.field !== "Tax");
    const kind = v.status === "Matched" ? "Matched" : v.status === "Not found" ? "Not found" : o ? "Amount differs (not tax)" : t ? "Tax" : "Review";
    ws.addRow([v.order, v.type === "sale" ? "Sale" : "Refund", kind, v.final || v.status, v.scenario, v.inDeposit ? "Yes" : "",
      v.final === "Skipped" ? "Skipped by the user. Nothing was changed in QuickBooks." : v.final === "Tax to enter by hand" ? `Enter tax ${(v.taxToEnter ?? 0).toFixed(2)} by hand in QuickBooks (Edit sales tax, Apply override).` : changeText(v),
      [v.reason, v.error, ...v.blockers].filter(Boolean).join(" | ")]);
  }

  const d = (rows.find((r) => r.date)?.date || "").split("/");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d[0]) - 1];
  const filename = d.length === 3 && mon ? `AuthorizeNet_${d[1]}_${mon}_output.xlsx` : "AuthorizeNet_output.xlsx";
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename };
}
