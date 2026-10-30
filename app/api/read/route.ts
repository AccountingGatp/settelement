// Step 1: read the settlement file and check that every order exists in QuickBooks.
import { handler } from "@/lib/route";
import { parseSettlement } from "@/lib/settlement";
import { existingDocNumbers, docNumberFor, status, searchDocs, scanNumbers, detectPrefix } from "@/lib/qb";
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
  const prefix: Record<string, string> = {}, notes: string[] = [];
  for (const type of ["sale", "refund"] as const) {
    const rows = s.rows.filter((r) => r.type === type);
    if (!rows.length) continue;
    // receipts are dated on or before the settlement date: look back 90 days from the earliest date in the file
    const ds = rows.map((r) => r.date || "").filter((d) => /^\d\d\/\d\d\/\d{4}$/.test(d)).map((d) => `${d.slice(6)}-${d.slice(0, 2)}-${d.slice(3, 5)}`).sort();
    const since = ds.length ? new Date(new Date(ds[0]).getTime() - 90 * 864e5).toISOString().slice(0, 10) : undefined;
    const numbers = await scanNumbers(type, since);
    const have = new Set(numbers);
    let pfx = docNumberFor(type, "").toString();
    // none of the numbers match the setting: see whether the books use another prefix
    if (!rows.some((r) => have.has(pfx + r.order))) {
      const alt = detectPrefix(numbers, new Set(rows.map((r) => r.order)));
      if (alt !== null && alt !== pfx) { notes.push(`QuickBooks numbers ${type === "sale" ? "sales receipts" : "refunds"} like “${alt}${rows[0].order}”, not “${pfx}${rows[0].order}”. The app used “${alt}” for this run. Set ${type === "sale" ? "DOC_PREFIX_SALE" : "DOC_PREFIX_REFUND"} in Vercel to ${alt || "none"} to make it permanent.`); pfx = alt; }
    }
    prefix[type] = pfx;
    // a few not seen in the window are looked up on their own (capped so the request stays short)
    const unseen = rows.filter((r) => !have.has(pfx + r.order)).map((r) => pfx + r.order);
    const extra = unseen.length <= 12 ? await existingDocNumbers(type, unseen) : new Set<string>();
    for (const r of rows) if (!have.has(pfx + r.order) && !extra.has(pfx + r.order)) missingInQbo.push({ order: r.order, type, docNumber: pfx + r.order });
  }
  // everything missing usually means a different number format (or another company): show what QuickBooks has for the first order
  const similar = missingInQbo.length === s.rows.length && s.rows.length > 0 ? await searchDocs(s.rows[0].order).catch(() => []) : [];
  return { ...s, missingInQbo, prefix, notes, similar, lookedFor: missingInQbo[0]?.docNumber || "" };
});
