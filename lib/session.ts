// Signed session cookie (works in both Edge middleware and Node routes via Web Crypto).
export const COOKIE = "recon_session";
const DAYS = 7;

async function hmac(text: string) {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 16) throw new Error("SESSION_SECRET is missing or too short");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeSession() {
  const exp = String(Date.now() + DAYS * 864e5);
  return { value: `${exp}.${await hmac(exp)}`, maxAge: DAYS * 86400 };
}

export async function validSession(value: string | undefined) {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  try {
    return (await hmac(exp)) === sig;
  } catch {
    return false;
  }
}
