// QuickBooks Online connection + the API calls this tool needs (read receipts, update them).
import { clearConn, readConn, writeConn, type Conn } from "./conn";

export const ENV: "sandbox" | "production" = process.env.QB_ENVIRONMENT === "production" ? "production" : "sandbox";
const API_BASE = ENV === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const MINOR = "75";

// "none" means the receipts are numbered with the bare order number and no prefix
const pre = (v: string | undefined, d: string) => {
  if (v === undefined) return d;
  const t = v.replace(/^\s*["']|["']\s*$/g, ""); // quotes pasted into the Vercel value are ignored
  return t.trim().toLowerCase() === "none" ? "" : t;
};
export const PREFIX = {
  sale: pre(process.env.DOC_PREFIX_SALE, "Woo Order#"),
  refund: pre(process.env.DOC_PREFIX_REFUND, "Woo Refund#"),
};
export type Kind = "sale" | "refund";
const ENTITY: Record<Kind, string> = { sale: "SalesReceipt", refund: "RefundReceipt" };
const PATH: Record<Kind, string> = { sale: "salesreceipt", refund: "refundreceipt" };
export const docNumberFor = (kind: Kind, order: string, prefix?: string) => `${prefix ?? PREFIX[kind]}${order}`;

// ---------------------------------------------------------------- OAuth
function basicAuth() {
  const id = process.env.QB_CLIENT_ID, secret = process.env.QB_CLIENT_SECRET;
  if (!id || !secret) throw new Error("QB_CLIENT_ID / QB_CLIENT_SECRET are not set.");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

export function authorizeUrl(state: string) {
  const p = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID || "",
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: process.env.QB_REDIRECT_URI || "",
    state,
  });
  return `https://appcenter.intuit.com/connect/oauth2?${p}`;
}

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QuickBooks login failed: ${j.error_description || j.error || r.status}`);
  return j as { access_token: string; refresh_token: string; expires_in: number };
}

export async function finishConnect(code: string, realmId: string) {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: process.env.QB_REDIRECT_URI || "" });
  const conn: Conn = { realmId, companyName: "", access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
  await writeConn(conn);
  const info = await api(`companyinfo/${realmId}`, undefined, conn);
  conn.companyName = info.CompanyInfo?.CompanyName || "QuickBooks company";
  await writeConn(conn);
}

export async function disconnect() {
  const c = await readConn();
  if (c)
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: c.refresh_token }),
    }).catch(() => {});
  await clearConn();
}

export async function status() {
  const c = await readConn();
  return {
    connected: !!c,
    companyName: c?.companyName || "",
    realmId: c?.realmId || "",
    environment: ENV,
    writesAllowed: ENV === "sandbox" || process.env.ALLOW_PRODUCTION_WRITES === "yes",
  };
}

async function conn(): Promise<Conn> {
  const c = await readConn();
  if (!c) throw new Error("QuickBooks is not connected. Click “Connect to QuickBooks”.");
  if (c.expires_at - 60_000 < Date.now()) {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh_token }).catch(async (e) => {
      await clearConn();
      throw new Error("The QuickBooks connection has expired. Click “Connect to QuickBooks” and log in again. (" + e.message + ")");
    });
    c.access_token = t.access_token;
    c.refresh_token = t.refresh_token; // Intuit rotates refresh tokens: keep the newest
    c.expires_at = Date.now() + t.expires_in * 1000;
    await writeConn(c);
  }
  return c;
}

// ---------------------------------------------------------------- raw API
export class QuickBooksError extends Error {
  constructor(message: string, readonly code: string, readonly traceId: string) { super(message); }
}

async function api(path: string, body?: unknown, using?: Conn): Promise<any> {
  const c = using ?? (await conn());
  const sep = path.includes("?") ? "&" : "?";
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API_BASE}/v3/company/${c.realmId}/${path}${sep}minorversion=${MINOR}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    // QuickBooks limits how fast it can be called (429): wait and try again
    if (r.status === 429 && attempt < 5) { await new Promise((ok) => setTimeout(ok, Math.max(Number(r.headers.get("retry-after")) * 1000 || 0, 1500 * 2 ** attempt))); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.Fault) {
      const e = j.Fault?.Error?.[0];
      const message = e ? `${e.Message}${e.Detail ? ": " + e.Detail : ""}` : r.status === 429
        ? "QuickBooks is busy (too many requests). Wait a minute and try again." : `QuickBooks error ${r.status}`;
      throw new QuickBooksError(message, String(e?.code || r.status), r.headers.get("intuit_tid") || "");
    }
    return j;
  }
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function queryAll(entity: string, where = ""): Promise<any[]> {
  const out: any[] = [];
  for (let start = 1; ; start += 1000) {
    const q = `select * from ${entity} ${where} startposition ${start} maxresults 1000`;
    const j = await api(`query?query=${encodeURIComponent(q)}`);
    const rows = j.QueryResponse?.[entity] || [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/** Writes to a production company stay blocked until ALLOW_PRODUCTION_WRITES=yes is set on purpose. */
export function assertWritable() {
  if (ENV === "production" && process.env.ALLOW_PRODUCTION_WRITES !== "yes")
    throw new Error("Changes to the real QuickBooks company are switched off (ALLOW_PRODUCTION_WRITES is not “yes”). Nothing was changed.");
}

// ---------------------------------------------------------------- receipts
export type QLine = { kind: "item" | "discount" | "subtotal" | "other"; itemId: string; name: string; qty: number; rate: number; amount: number; taxCode: string };
export type QDoc = {
  kind: Kind; id: string; syncToken: string; docNumber: string; total: number; tax: number;
  lines: QLine[]; inDeposit: boolean; customer: string; raw: any;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function view(kind: Kind, raw: any): QDoc {
  const lines: QLine[] = (raw.Line || []).map((l: any): QLine => {
    if (l.DetailType === "SubTotalLineDetail") return { kind: "subtotal", itemId: "", name: "", qty: 0, rate: 0, amount: Number(l.Amount || 0), taxCode: "" };
    if (l.DetailType === "DiscountLineDetail") return { kind: "discount", itemId: "", name: "Discount", qty: 0, rate: 0, amount: Number(l.Amount || 0), taxCode: l.DiscountLineDetail?.TaxCodeRef?.value || "" };
    const d = l.SalesItemLineDetail;
    if (!d) return { kind: "other", itemId: "", name: l.Description || "", qty: 0, rate: 0, amount: Number(l.Amount || 0), taxCode: "" };
    return {
      kind: "item", itemId: d.ItemRef?.value || "", name: d.ItemRef?.name || l.Description || "", qty: Number(d.Qty ?? 1), rate: Number(d.UnitPrice ?? 0),
      amount: Number(l.Amount || 0), taxCode: d.TaxCodeRef?.value || "",
    };
  });
  const dep = (raw.LinkedTxn || []).some((t: any) => t.TxnType === "Deposit");
  return {
    kind, id: raw.Id, syncToken: raw.SyncToken, docNumber: raw.DocNumber || "",
    total: round2(Number(raw.TotalAmt || 0)), tax: round2(Number(raw.TxnTaxDetail?.TotalTax || 0)),
    lines, inDeposit: dep, customer: raw.CustomerRef?.name || "", raw,
  };
}

/** If the books number receipts differently from the setting (for example "Order#73102" instead of "Woo Order#73102"),
 *  find the text in front of the order number that most receipts for orders in the file share. */
export function detectPrefix(numbers: string[], orders: Set<string>): string | null {
  const count = new Map<string, number>();
  for (const n of numbers) {
    const m = n.match(/^(.*?)(\d+)$/);
    if (m && orders.has(m[2])) count.set(m[1], (count.get(m[1]) || 0) + 1);
  }
  let best: string | null = null, top = 0;
  for (const [p, c] of count) if (c > top) { best = p; top = c; }
  return best;
}

/** Which of these exact document numbers exist? Query up to 40 numbers at a time. */
export async function existingDocNumbers(kind: Kind, docNumbers: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < docNumbers.length; i += 40) {
    const list = docNumbers.slice(i, i + 40).map((d) => `'${esc(d)}'`).join(",");
    const j = await api(`query?query=${encodeURIComponent(`select * from ${ENTITY[kind]} where DocNumber IN (${list}) maxresults 1000`)}`);
    for (const r of j.QueryResponse?.[ENTITY[kind]] || []) found.add(String(r.DocNumber));
  }
  return found;
}

export async function findDoc(kind: Kind, order: string, prefix?: string, linkedNumber?: string): Promise<QDoc | null> {
  const entity = ENTITY[kind];
  const candidates = new Set([linkedNumber, docNumberFor(kind, order, prefix), docNumberFor(kind, order)]);
  for (const number of candidates) {
    if (!number) continue;
    const rows = await queryAll(entity, `where DocNumber = '${esc(number)}'`);
    if (rows.length > 1) throw new Error(`More than one ${entity} has the number “${number}”. Check QuickBooks.`);
    if (rows.length === 1) return view(kind, rows[0]);
  }
  const matches = (await queryAll(entity, `where DocNumber like '%${esc(order)}'`))
    .filter((receipt) => String(receipt.DocNumber || "").match(/\d+$/)?.[0] === order);
  if (matches.length > 1) throw new Error(`More than one ${entity} ends in order ${order}. Confirm the linked transaction number.`);
  return matches.length ? view(kind, matches[0]) : null;
}

/** Find any transaction whose number contains the text, in the connected company. Used to see what numbers the books really use. */
export type Found = { type: string; docNumber: string; date: string; total: number; customer: string };
export async function searchDocs(text: string): Promise<Found[]> {
  const t = text.replace(/[^A-Za-z0-9#\- ]/g, "").trim();
  if (!t) return [];
  const out: Found[] = [];
  for (const ent of ["SalesReceipt", "RefundReceipt", "Invoice", "CreditMemo"]) {
    const j = await api(`query?query=${encodeURIComponent(`select * from ${ent} where DocNumber like '%${t}%' maxresults 10`)}`);
    for (const r of j.QueryResponse?.[ent] || []) out.push({ type: ent, docNumber: r.DocNumber || "", date: r.TxnDate || "", total: round2(Number(r.TotalAmt || 0)), customer: r.CustomerRef?.name || "" });
  }
  return out;
}

/** Re-read straight from QuickBooks (used to verify after a save). */
export async function reread(kind: Kind, id: string): Promise<QDoc> {
  const j = await api(`${PATH[kind]}/${encodeURIComponent(id)}`);
  const saved = j[ENTITY[kind]];
  if (!saved || String(saved.Id) !== String(id) || saved.TotalAmt == null || !Number.isFinite(Number(saved.TotalAmt))) {
    throw new Error("QuickBooks did not return the requested receipt and its total.");
  }
  return view(kind, saved);
}

// ---------------------------------------------------------------- receipt corrections
export async function findRefundAdjustmentItem(): Promise<{ id: string; name: string } | undefined> {
  const name = process.env.QB_REFUND_ADJUSTMENT_ITEM?.trim();
  if (!name) return undefined;
  const items = await queryAll("Item", `where Name = '${esc(name)}'`);
  const item = items.length === 1 ? items[0] : null;
  if (!item || item.Active !== true || !["Service", "NonInventory"].includes(item.Type) || !item.IncomeAccountRef?.value) {
    throw new Error(`QuickBooks refund adjustment item “${name}” must be a unique, active service or non-inventory item with an income account.`);
  }
  return { id: String(item.Id), name: String(item.Name) };
}

export type FixStep = { kind: "total" | "lines" | "override"; tax: number };
type Adjustment = { id: string; name: string; amount: number };
const receiptLines = (doc: QDoc): any[] => (doc.raw.Line || []).filter((l: any) => l.DetailType !== "SubTotalLineDetail");
const totalTaxDetail = (doc: QDoc, tax: number) => {
  const code = doc.raw.TxnTaxDetail?.TxnTaxCodeRef;
  return { ...(code ? { TxnTaxCodeRef: code } : {}), TotalTax: tax };
};

async function saveReceipt(doc: QDoc, fields: Record<string, unknown>): Promise<QDoc> {
  assertWritable();
  const result = await api(PATH[doc.kind], { Id: doc.id, SyncToken: doc.syncToken, sparse: true, ...fields });
  return view(doc.kind, result[ENTITY[doc.kind]]);
}

/** Compare the amounts and codes on the original economic lines, ignoring QBO-generated subtotals and ordering. */
export function sameReceiptLines(a: QDoc, b: QDoc): boolean {
  const signatures = (doc: QDoc) => doc.lines.filter((line) => line.kind !== "subtotal").map((line) =>
    JSON.stringify([line.kind, line.itemId, round2(line.amount), line.qty, line.rate, line.taxCode])).sort();
  return JSON.stringify(signatures(a)) === JSON.stringify(signatures(b));
}

export function applyTaxStep(doc: QDoc, baseline: QDoc, step: FixStep, adjustment?: Adjustment): Promise<QDoc> {
  const td = totalTaxDetail(baseline, step.tax);
  // The settlement tax is the full tax, including any shipping tax.
  const taxOverride = { ShippingTaxIncludedInTotalTax: true, TxnTaxDetail: td };
  if (step.kind === "total" && !adjustment && sameReceiptLines(doc, baseline)) return saveReceipt(doc, taxOverride);
  const lines = receiptLines(baseline);
  if (adjustment) {
    // Rebuild from the starting receipt so every attempt targets the same total.
    // Reuse a line ID if a previous attempt already appended the adjustment.
    const existingIds = new Set(lines.map((line) => line.Id).filter(Boolean));
    const prior = receiptLines(doc).find((line) => line.Id && !existingIds.has(line.Id) &&
      String(line.SalesItemLineDetail?.ItemRef?.value) === adjustment.id);
    lines.push({
      ...(prior ? { Id: prior.Id } : {}),
      DetailType: "SalesItemLineDetail", Amount: adjustment.amount, Description: "Settlement refund adjustment",
      SalesItemLineDetail: { ItemRef: { value: adjustment.id }, Qty: 1, UnitPrice: adjustment.amount, TaxCodeRef: { value: "NON" } },
    });
  }
  const sourceTax = doc.raw.TxnTaxDetail?.TaxLine?.length ? doc.raw.TxnTaxDetail : baseline.raw.TxnTaxDetail;
  return saveReceipt(doc, {
    ...taxOverride, Line: lines,
    TxnTaxDetail: step.kind === "override" ? retargetTax(sourceTax, step.tax) : td,
  });
}

export function restore(doc: QDoc, original: QDoc): Promise<QDoc> {
  const detail = original.raw.TxnTaxDetail || { TotalTax: original.tax };
  return saveReceipt(doc, {
    ...(sameReceiptLines(doc, original) ? {} : { Line: receiptLines(original) }),
    ShippingTaxIncludedInTotalTax: true,
    TxnTaxDetail: detail,
  });
}

/** Spread a new total tax over the receipt's tax lines (in proportion to what each holds) and record the difference on each line as the
 *  override amount, which is what the QuickBooks screen stores when tax is overridden with "See the math". Pure: easy to test. */
export function retargetTax(td: any, target: number): any {
  const t = JSON.parse(JSON.stringify(td || {}));
  const lines: any[] = Array.isArray(t.TaxLine) ? t.TaxLine : [];
  if (!lines.length) throw new Error("This receipt has no tax line to override. Enter the tax by hand.");
  const sum = lines.reduce((a, l) => a + Number(l.Amount || 0), 0);
  let allocated = 0;
  let weight = 0;
  lines.forEach((l, i) => {
    const old = Number(l.Amount || 0);
    weight += sum > 0 ? old / sum : 1 / lines.length;
    const cumulative = i === lines.length - 1 ? target : round2(weight * target);
    const n = round2(cumulative - allocated);
    allocated = cumulative;
    l.Amount = n;
    l.TaxLineDetail = { ...(l.TaxLineDetail || {}), OverrideDeltaAmount: round2(Number(l.TaxLineDetail?.OverrideDeltaAmount || 0) + (n - old)) };
  });
  t.TotalTax = target;
  return t;
}

/** A short, plain reason for a failed fix, from QuickBooks's message. */
export function explainFailure(err: unknown, ctx?: { taxStillWrong?: boolean; totalStillWrong?: boolean }): string {
  const m = err instanceof Error ? err.message : String(err ?? "");
  if (/activate this item|inactive/i.test(m)) return "A QuickBooks item on the receipt is inactive.";
  if (/stale|syncToken/i.test(m)) return "Someone changed the receipt while the fix was running. Run the check again.";
  if (/period|closing date|closed/i.test(m)) return "The accounting period is closed for this date.";
  if (/not connected|connect/i.test(m)) return "QuickBooks is not connected.";
  if (/writes|ALLOW_PRODUCTION/i.test(m)) return "Saving to the real company is switched off.";
  if (m) return m.length > 160 ? m.slice(0, 160) + "…" : m;
  if (ctx?.taxStillWrong) return "QuickBooks did not take the new tax amount.";
  if (ctx?.totalStillWrong) return "The receipt total still differs from the file after saving.";
  return "Unknown.";
}

/** Where to open a receipt in the QuickBooks web app. */
export function qbLink(kind: Kind, id: string): string {
  const host = ENV === "sandbox" ? "https://app.sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com";
  return `${host}/app/${kind === "sale" ? "salesreceipt" : "refundreceipt"}?txnId=${encodeURIComponent(id)}`;
}
