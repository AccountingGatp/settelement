import { NextResponse } from "next/server";
// Wraps an API handler so any error comes back as { error } with a readable message.
export function handler<T extends unknown[]>(fn: (...a: T) => Promise<unknown>) {
  return async (...a: T) => {
    try {
      const out = await fn(...a);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      console.error(e);
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  };
}
