// Step 1: read the settlement file and check that every order exists in QuickBooks.
import { handler } from "@/lib/route";
import { parseSettlement } from "@/lib/settlement";
import { existingDocNumbers, docNumberFor, status, searchDocs } from "@/lib/qb";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request) => {
  let s: ReturnType<typeof parseSettlement>;
  if ((req.headers.get("content-type") || "").includes("application/json")) {
    // the browser has already read the file; only the rows arrive here
    const b = (await req.json())?.settlement;
    if (!b || !Array.isArray(b.rows)) throw new Error("No file was received. Please choose the file again.");
    const rows = b.rows.map((r: any) => {
      if (!/^\d+$/.test(String(r.order)) || (r.type !== "sale" && r.type !== "refund") || !Number.isFinite(Number(r.amount))) throw new Error("The file has a row that could not be read.");
      return { order: String(r.order), type: r.type, amount: Number(r.amount), fileTax: Number(r.fileTax || 0), fileFreight: Number(r.fileFreight || 0), txnId: String(r.txnId || ""), customer: String(r.customer || ""), date: String(r.date || ""), depositNo: String(r.depositNo || ""), receivedFrom: String(r.receivedFrom || "") };
    });
    s = { rows, skipped: Array.isArray(b.skipped) ? b.skipped : [], problems: Array.isArray(b.problems) ? b.problems.map(String) : [], counts: b.counts && typeof b.counts === "object" ? b.counts : {} };
  } else {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("No file was received. Please choose the file again.");
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("Please upload the Authorize.net settlement download (.xlsx or .csv).");
    s = parseSettlement(await file.arrayBuffer());
  }
  if (s.problems.length && !s.rows.length) return { ...s, missingInQbo: [] };
  const st = await status();
  if (!st.connected) throw new Error("QuickBooks is not connected. Click “Connect to QuickBooks” at the top.");
  const missingInQbo: { order: string; type: string; docNumber: string }[] = [];
  for (const type of ["sale", "refund"] as const) {
    const rows = s.rows.filter((r) => r.type === type);
    if (!rows.length) continue;
    const found = await existingDocNumbers(type, rows.map((r) => docNumberFor(type, r.order)));
    for (const r of rows) {
      const dn = docNumberFor(type, r.order);
      if (!found.has(dn)) missingInQbo.push({ order: r.order, type, docNumber: dn });
    }
  }
  // everything missing usually means a different number format (or another company): show what QuickBooks has for the first order
  const similar = missingInQbo.length === s.rows.length && s.rows.length > 0 ? await searchDocs(s.rows[0].order).catch(() => []) : [];
  return { ...s, missingInQbo, similar, lookedFor: missingInQbo[0]?.docNumber || "" };
});
