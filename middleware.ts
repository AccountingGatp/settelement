import { NextRequest, NextResponse } from "next/server";
import { COOKIE, validSession } from "@/lib/session";

// Pages anyone can open (Intuit requires public privacy/terms pages).
const PUBLIC = ["/login", "/api/login", "/privacy", "/terms"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p) || pathname.startsWith("/_next") || pathname === "/favicon.ico")
    return NextResponse.next();
  if (await validSession(req.cookies.get(COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/"))
    return NextResponse.json({ error: "Please log in again." }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
