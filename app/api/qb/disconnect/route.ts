import { handler } from "@/lib/route";
import { disconnect } from "@/lib/qb";
export const POST = handler(async () => { await disconnect(); return { ok: true }; });
