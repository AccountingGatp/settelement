import { NextResponse } from "next/server";
import { authorizeUrl } from "@/lib/qb";
export const dynamic = "force-dynamic";
export async function GET() {
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set("qb_state", state, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
