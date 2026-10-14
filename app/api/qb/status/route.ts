import { handler } from "@/lib/route";
import { status } from "@/lib/qb";
export const dynamic = "force-dynamic";
export const GET = handler(async () => status());
