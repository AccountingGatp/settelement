// Step 1: read the settlement file and check that every order exists in QuickBooks.
import { handler } from "@/lib/route";
import { parseRow } from "@/lib/run";
import { parseSettlement } from "@/lib/settlement";
import { existingDocNumbers, docNumberFor, status, searchDocs, detectPrefix } from "@/lib/qb";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request) => {
  let s: ReturnType<typeof parseSettlement>;
  if ((req.headers.get("content-type") || "").includes("application/json")) {
    // the browser has already read the file; only the rows arrive here
    const b = (await req.json())?.settlement;
    if (!b || !Array.isArray(b.rows)) throw new Error("No file was received. Please choose the file again.");
    const rows = b.rows.map((row: unknown) => parseRow({ row }));
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
    // look up the exact numbers straight away: no date range, no scanning
    let pfx = docNumberFor(type, "");
    const numbers = (prefix: string) => Array.from(new Set(rows.flatMap((r) => r.docNumber ? [r.docNumber, prefix + r.order] : [prefix + r.order])));
    let found: Set<string>;
    try { found = await existingDocNumbers(type, numbers(pfx)); }
    catch {
      notes.push(`The preliminary ${type} receipt lookup was unavailable. Run the check to look up each receipt.`);
      continue;
    }
    if (!found.size) {
      // nothing matched: see how QuickBooks really numbers the first order, and try again with that prefix
      const seen = (await searchDocs(rows[0].order).catch(() => [])).filter((f) => (type === "sale" ? f.type === "SalesReceipt" : f.type === "RefundReceipt")).map((f) => f.docNumber);
      const alt = detectPrefix(seen, new Set([rows[0].order]));
      if (alt !== null && alt !== pfx) {
        notes.push(`QuickBooks numbers ${type === "sale" ? "sales receipts" : "refunds"} like “${alt}${rows[0].order}”, not “${pfx}${rows[0].order}”. The app used “${alt}” for this run. Set ${type === "sale" ? "DOC_PREFIX_SALE" : "DOC_PREFIX_REFUND"} in Vercel to ${alt || "none"} to make it permanent.`);
        pfx = alt; found = await existingDocNumbers(type, numbers(pfx)).catch(() => new Set<string>());
      }
    }
    prefix[type] = pfx;
    for (const r of rows) if (!found.has(pfx + r.order) && !(r.docNumber && found.has(r.docNumber))) missingInQbo.push({ order: r.order, type, docNumber: r.docNumber || pfx + r.order });
  }
  // everything missing usually means a different number format (or another company): show what QuickBooks has for the first order
  const similar = missingInQbo.length === s.rows.length && s.rows.length > 0 ? await searchDocs(s.rows[0].order).catch(() => []) : [];
  return { ...s, missingInQbo, prefix, notes, similar, lookedFor: missingInQbo[0]?.docNumber || "" };
});
