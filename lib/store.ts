// Tiny key-value store.
// On Vercel: Upstash Redis via its REST API (env KV_REST_API_URL / KV_REST_API_TOKEN,
// or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// Locally (no Redis configured): a JSON file in .data/ so it survives restarts.
import { promises as fs } from "fs";
import path from "path";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const FILE = path.join(process.cwd(), ".data", "store.json");

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

async function readFile(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

function checkConfigured() {
  if (!URL_ && process.env.VERCEL)
    throw new Error("Storage is not set up. In Vercel, add an Upstash Redis database (Storage tab).");
}

export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  checkConfigured();
  let raw: string | null;
  if (URL_) raw = await redis(["GET", key]);
  else raw = (await readFile())[key] ?? null;
  return raw == null ? null : (JSON.parse(raw) as T);
}

export async function kvSet(key: string, value: unknown) {
  checkConfigured();
  const raw = JSON.stringify(value);
  if (URL_) return void (await redis(["SET", key, raw]));
  const data = await readFile();
  data[key] = raw;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 1));
}

/** Lock a key for `seconds` (Redis SET NX EX). Returns false if someone else holds it. */
export async function kvLock(key: string, seconds = 120): Promise<boolean> {
  checkConfigured();
  if (URL_) return (await redis(["SET", key, "1", "NX", "EX", seconds])) === "OK";
  const data = await readFile();
  const until = Number(data[key] ? JSON.parse(data[key]) : 0);
  if (until > Date.now()) return false;
  await kvSet(key, Date.now() + seconds * 1000);
  return true;
}

export async function kvDel(key: string) {
  checkConfigured();
  if (URL_) return void (await redis(["DEL", key]));
  const data = await readFile();
  delete data[key];
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 1));
}
