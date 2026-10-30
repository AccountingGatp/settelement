// The QuickBooks login is kept in an encrypted cookie in the user's own browser. Nothing is stored on any server or database.
import { cookies } from "next/headers";

export type Conn = { realmId: string; companyName: string; access_token: string; refresh_token: string; expires_at: number };
const NAME = "qb_conn";
const MAX_AGE = 100 * 86400; // QuickBooks refresh tokens last about 100 days

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64url");
async function key() {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 16) throw new Error("SESSION_SECRET is missing or too short");
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("qb-conn:" + secret));
  return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(c: Conn): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(c))));
  return b64(iv) + "." + b64(ct);
}
export async function unseal(v: string | undefined): Promise<Conn | null> {
  try {
    if (!v) return null;
    const [iv, ct] = v.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url") }, await key(), Buffer.from(ct, "base64url"));
    return JSON.parse(new TextDecoder().decode(pt)) as Conn;
  } catch { return null; }
}

export const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: MAX_AGE };
export async function readConn(): Promise<Conn | null> { return unseal((await cookies()).get(NAME)?.value); }
export async function writeConn(c: Conn) { (await cookies()).set(NAME, await seal(c), cookieOptions); }
export async function clearConn() { (await cookies()).delete(NAME); }
