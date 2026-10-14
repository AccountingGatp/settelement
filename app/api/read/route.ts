// Step 1: read the settlement file and check that every order exists in QuickBooks.
import { handler } from "@/lib/route";
import { parseSettlement } from "@/lib/settlement";
import { existingDocNumbers, docNumberFor, status } from "@/lib/qb";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("No file was received. Please choose the file again.");
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("Please upload the Authorize.net settlement download (.xlsx or .csv).");
  const s = parseSettlement(await file.arrayBuffer());
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
  return { ...s, missingInQbo };
});
