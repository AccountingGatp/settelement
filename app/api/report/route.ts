// Builds the output workbook (same layout as the team's AuthorizeNet_<day>_output file) from the results the page holds.
import { buildOutput, type OutRow } from "@/lib/outputSheet";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { results } = (await req.json()) as { results: OutRow[] };
  const { buffer, filename } = await buildOutput(results || []);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"` } });
}
