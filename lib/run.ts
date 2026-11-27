// One row, end to end: look up QuickBooks, compare with the file. Shared by the check and fix routes.
import { findDoc, qbLink } from "./qb";
import { reconcile, type Verdict } from "./recon";
import type { Row } from "./settlement";

export async function checkRow(row: Row): Promise<{ verdict: Verdict; doc: Awaited<ReturnType<typeof findDoc>> }> {
  const doc = await findDoc(row.type, row.order, row.prefix, row.docNumber);
  const verdict = reconcile(row, doc);
  if (doc) verdict.link = qbLink(row.type, doc.id);
  return { verdict, doc };
}

export function parseRow(body: any): Row {
  const r = body?.row;
  if (!r || !/^\d+$/.test(String(r.order)) || (r.type !== "sale" && r.type !== "refund") || !Number.isFinite(Number(r.amount)))
    throw new Error("Bad row.");
  const order = String(r.order);
  const fileTax = r.fileTax == null ? (r.type === "refund" ? null : 0) : Number(r.fileTax);
  if (fileTax !== null && !Number.isFinite(fileTax)) throw new Error("Invalid file tax.");
  const docNumber = typeof r.docNumber === "string" && r.docNumber.length <= 100 && r.docNumber.match(/\d+$/)?.[0] === order ? r.docNumber : undefined;
  return {
    order, type: r.type, amount: Number(r.amount), fileTax, docNumber,
    fileFreight: Number(r.fileFreight || 0), txnId: String(r.txnId || ""),
    customer: String(r.customer || ""), date: String(r.date || ""), depositNo: String(r.depositNo || ""), receivedFrom: String(r.receivedFrom || ""),
    prefix: typeof r.prefix === "string" && /^[A-Za-z0-9#\-_. ]{0,30}$/.test(r.prefix) ? r.prefix : undefined,
    reviewReason: typeof r.reviewReason === "string" ? r.reviewReason.slice(0, 200) : undefined,
  };
}
