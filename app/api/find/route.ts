// Look up transactions by (part of) their number in the connected QuickBooks company. Read only.
import { handler } from "@/lib/route";
import { searchDocs } from "@/lib/qb";
export const dynamic = "force-dynamic";
export const POST = handler(async (req: Request) => ({ found: await searchDocs(String((await req.json())?.q || "")) }));
