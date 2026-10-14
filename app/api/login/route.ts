import { NextResponse } from "next/server";
import { COOKIE, makeSession } from "@/lib/session";

export async function POST(req: Request) {
  try {
    const { password } = await req.json().catch(() => ({ password: "" }));
    const expected = process.env.APP_PASSWORD;
    if (!expected) return NextResponse.json({ error: "Setup problem: APP_PASSWORD is not set in Vercel (then Redeploy)." }, { status: 500 });
    if ((process.env.SESSION_SECRET || "").length < 16)
      return NextResponse.json({ error: "Setup problem: SESSION_SECRET is missing or too short in Vercel (then Redeploy)." }, { status: 500 });
    if (password !== expected) return NextResponse.json({ error: "Wrong password." }, { status: 401 });
    const s = await makeSession();
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE, s.value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: s.maxAge, path: "/" });
    return res;
  } catch (e) {
    return NextResponse.json({ error: "Login error: " + (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
