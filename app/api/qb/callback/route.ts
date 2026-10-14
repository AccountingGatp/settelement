import { NextRequest, NextResponse } from "next/server";
import { finishConnect } from "@/lib/qb";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const home = new URL("/", req.url);
  const fail = (msg: string) => { home.searchParams.set("error", msg); return NextResponse.redirect(home); };
  if (p.get("error")) return fail("QuickBooks connection was cancelled.");
  if (!p.get("state") || p.get("state") !== req.cookies.get("qb_state")?.value)
    return fail("Connection check failed. Please click Connect again.");
  try {
    await finishConnect(p.get("code") || "", p.get("realmId") || "");
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Could not connect.");
  }
  const res = NextResponse.redirect(home);
  res.cookies.delete("qb_state");
  return res;
}
