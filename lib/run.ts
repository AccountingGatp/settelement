// One row, end to end: look up QuickBooks, compare with the file. Shared by the check and fix routes.
import { findDoc, qbLink } from "./qb";
import { reconcile, type Verdict } from "./recon";
import type { Row } from "./settlement";

export async function checkRow(row: Row): Promise<{ verdict: Verdict; doc: Awaited<ReturnType<typeof findDoc>> }> {
  const doc = await findDoc(row.type, row.order);
  const verdict = reconcile(row, doc);
  if (doc) verdict.link = qbLink(row.type, doc.id);
  return { verdict, doc };
}

export function parseRow(body: any): Row {
  const r = body?.row;
  if (!r || !/^\d+$/.test(String(r.order)) || (r.type !== "sale" && r.type !== "refund") || !Number.isFinite(Number(r.amount)))
    throw new Error("Bad row.");
  return { order: String(r.order), type: r.type, amount: Number(r.amount), fileTax: Number(r.fileTax || 0), fileFreight: Number(r.fileFreight || 0), txnId: String(r.txnId || ""), customer: String(r.customer || ""), date: String(r.date || ""), depositNo: String(r.depositNo || ""), receivedFrom: String(r.receivedFrom || "") };
}
