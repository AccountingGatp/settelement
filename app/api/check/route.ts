// Dry run for one row. Writes nothing.
import { handler } from "@/lib/route";
import { checkRow, parseRow } from "@/lib/run";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const POST = handler(async (req: Request) => {
  const row = parseRow(await req.json());
  return (await checkRow(row)).verdict;
});
