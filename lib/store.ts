// Tiny key-value store with three back ends, chosen by environment variables:
//   1. Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY): table "kv", see supabase.sql
//   2. Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN)
//   3. Local JSON file in .data/ (development only)
import { promises as fs } from "fs";
import path from "path";

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const FILE = path.join(process.cwd(), ".data", "store.json");

// Every key is prefixed so the store can be shared with other projects.
const P = "recon:";
const k = (key: string) => P + key;

// ---------- Supabase (PostgREST) ----------
async function sb(method: string, query: string, body?: unknown, prefer?: string) {
  const r = await fetch(`${SB_URL}/rest/v1/kv${query}`, {
    method,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (r.status === 409) return { conflict: true as const, data: null };
  if (!r.ok) throw new Error(`Storage error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return { conflict: false as const, data: text ? JSON.parse(text) : null };
}
const eq = (key: string) => `key=eq.${encodeURIComponent(key)}`;

// ---------- Upstash ----------
async function redis(cmd: (string | number)[]) {
  const r = await fetch(URL_!, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Storage error ${r.status}`);
  return (await r.json()).result;
}

// ---------- local file ----------
async function readFile(): Promise<Record<string, string>> {
  try { return JSON.parse(await fs.readFile(FILE, "utf8")); } catch { return {}; }
}
async function writeFile(data: Record<string, string>) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 1));
}

function checkConfigured() {
  if (!SB_URL && !URL_ && process.env.VERCEL)
    throw new Error("Storage is not set up. Add SUPABASE_URL and SUPABASE_SERVICE_KEY (or an Upstash Redis database) in Vercel.");
}

export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  checkConfigured(); key = k(key);
  if (SB_URL) {
    const { data } = await sb("GET", `?${eq(key)}&select=value,expires_at`);
    const row = data?.[0];
    if (!row || (row.expires_at && new Date(row.expires_at).getTime() < Date.now())) return null;
    return row.value as T;
  }
  const raw: string | null = URL_ ? await redis(["GET", key]) : ((await readFile())[key] ?? null);
  return raw == null ? null : (JSON.parse(raw) as T);
}

export async function kvSet(key: string, value: unknown) {
  checkConfigured(); key = k(key);
  if (SB_URL) { await sb("POST", "?on_conflict=key", { key, value, expires_at: null }, "resolution=merge-duplicates,return=minimal"); return; }
  const raw = JSON.stringify(value);
  if (URL_) return void (await redis(["SET", key, raw]));
  const data = await readFile(); data[key] = raw; await writeFile(data);
}

/** Lock a key for `seconds`. Returns false if someone else holds it. */
export async function kvLock(key: string, seconds = 120): Promise<boolean> {
  checkConfigured(); key = k(key);
  if (SB_URL) {
    await sb("DELETE", `?${eq(key)}&expires_at=lt.${encodeURIComponent(new Date().toISOString())}`); // drop an expired lock
    const res = await sb("POST", "", { key, value: 1, expires_at: new Date(Date.now() + seconds * 1000).toISOString() }, "return=minimal");
    return !res.conflict;
  }
  if (URL_) return (await redis(["SET", key, "1", "NX", "EX", seconds])) === "OK";
  const data = await readFile();
  if (Number(data[key] ? JSON.parse(data[key]) : 0) > Date.now()) return false;
  data[key] = JSON.stringify(Date.now() + seconds * 1000); await writeFile(data);
  return true;
}

export async function kvDel(key: string) {
  checkConfigured(); key = k(key);
  if (SB_URL) { await sb("DELETE", `?${eq(key)}`); return; }
  if (URL_) return void (await redis(["DEL", key]));
  const data = await readFile(); delete data[key]; await writeFile(data);
}
