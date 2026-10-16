// QuickBooks Online connection + the API calls this tool needs (read receipts, update them).
import { kvDel, kvGet, kvSet } from "./store";

export const ENV: "sandbox" | "production" = process.env.QB_ENVIRONMENT === "production" ? "production" : "sandbox";
const API_BASE = ENV === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const MINOR = "75";
const CONN_KEY = `qb:conn:${ENV}`;

export const PREFIX = {
  sale: process.env.DOC_PREFIX_SALE ?? "Woo Order#",
  refund: process.env.DOC_PREFIX_REFUND ?? "Woo Refund#",
};
export type Kind = "sale" | "refund";
const ENTITY: Record<Kind, string> = { sale: "SalesReceipt", refund: "RefundReceipt" };
const PATH: Record<Kind, string> = { sale: "salesreceipt", refund: "refundreceipt" };
export const docNumberFor = (kind: Kind, order: string) => `${PREFIX[kind]}${order}`;

type Conn = { realmId: string; companyName: string; access_token: string; refresh_token: string; expires_at: number };

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
  await kvSet(CONN_KEY, conn);
  const info = await api(`companyinfo/${realmId}`);
  conn.companyName = info.CompanyInfo?.CompanyName || "QuickBooks company";
  await kvSet(CONN_KEY, conn);
}

export async function disconnect() {
  const c = await kvGet<Conn>(CONN_KEY);
  if (c)
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: c.refresh_token }),
    }).catch(() => {});
  await kvDel(CONN_KEY);
}

export async function status() {
  const c = await kvGet<Conn>(CONN_KEY);
  return {
    connected: !!c,
    companyName: c?.companyName || "",
    realmId: c?.realmId || "",
    environment: ENV,
    writesAllowed: ENV === "sandbox" || process.env.ALLOW_PRODUCTION_WRITES === "yes",
  };
}

async function conn(): Promise<Conn> {
  const c = await kvGet<Conn>(CONN_KEY);
  if (!c) throw new Error("QuickBooks is not connected. Click “Connect to QuickBooks”.");
  if (c.expires_at - 60_000 < Date.now()) {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh_token }).catch(async (e) => {
      await kvDel(CONN_KEY);
      throw new Error("The QuickBooks connection has expired. Click “Connect to QuickBooks” and log in again. (" + e.message + ")");
    });
    c.access_token = t.access_token;
    c.refresh_token = t.refresh_token; // Intuit rotates refresh tokens: keep the newest
    c.expires_at = Date.now() + t.expires_in * 1000;
    await kvSet(CONN_KEY, c);
  }
  return c;
}

// ---------------------------------------------------------------- raw API
async function api(path: string, body?: unknown): Promise<any> {
  const c = await conn();
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${API_BASE}/v3/company/${c.realmId}/${path}${sep}minorversion=${MINOR}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.Fault) {
    const e = j.Fault?.Error?.[0];
    throw new Error(e ? `${e.Message}${e.Detail ? ": " + e.Detail : ""}` : `QuickBooks error ${r.status}`);
  }
  return j;
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

// ---------------------------------------------------------------- items (cached for a minute)
export type QItem = { id: string; name: string; sku: string; type: string; active: boolean };
let itemCache: { at: number; items: QItem[] } | null = null;
export async function listItems(force = false): Promise<QItem[]> {
  if (!force && itemCache && Date.now() - itemCache.at < 60_000) return itemCache.items;
  const items = (await queryAll("Item", "where Active IN (true, false)")).map((i) => ({
    id: i.Id as string, name: i.Name as string, sku: (i.Sku || "") as string, type: i.Type as string, active: i.Active !== false,
  }));
  itemCache = { at: Date.now(), items };
  return items;
}

// ---------------------------------------------------------------- receipts
export type QLine = { kind: "item" | "discount" | "subtotal" | "other"; itemId: string; name: string; sku: string; qty: number; rate: number; amount: number; taxCode: string };
export type QDoc = {
  kind: Kind; id: string; syncToken: string; docNumber: string; total: number; tax: number;
  lines: QLine[]; inDeposit: boolean; customer: string; raw: any;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function view(kind: Kind, raw: any, items: QItem[]): QDoc {
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines: QLine[] = (raw.Line || []).map((l: any): QLine => {
    if (l.DetailType === "SubTotalLineDetail") return { kind: "subtotal", itemId: "", name: "", sku: "", qty: 0, rate: 0, amount: Number(l.Amount || 0), taxCode: "" };
    if (l.DetailType === "DiscountLineDetail") return { kind: "discount", itemId: "", name: "Discount", sku: "", qty: 0, rate: 0, amount: Number(l.Amount || 0), taxCode: l.DiscountLineDetail?.TaxCodeRef?.value || "" };
    const d = l.SalesItemLineDetail;
    if (!d) return { kind: "other", itemId: "", name: l.Description || "", sku: "", qty: 0, rate: 0, amount: Number(l.Amount || 0), taxCode: "" };
    const it = byId.get(d.ItemRef?.value);
    return {
      kind: "item", itemId: d.ItemRef?.value || "", name: it?.name || d.ItemRef?.name || "", sku: it?.sku || "",
      qty: Number(d.Qty ?? 1), rate: Number(d.UnitPrice ?? 0), amount: Number(l.Amount || 0), taxCode: d.TaxCodeRef?.value || "",
    };
  });
  const dep = (raw.LinkedTxn || []).some((t: any) => t.TxnType === "Deposit");
  return {
    kind, id: raw.Id, syncToken: raw.SyncToken, docNumber: raw.DocNumber || "",
    total: round2(Number(raw.TotalAmt || 0)), tax: round2(Number(raw.TxnTaxDetail?.TotalTax || 0)),
    lines, inDeposit: dep, customer: raw.CustomerRef?.name || "", raw,
  };
}

/** Which of these document numbers exist in QuickBooks? (one query per 40 numbers) */
export async function existingDocNumbers(kind: Kind, docNumbers: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < docNumbers.length; i += 40) {
    const chunk = docNumbers.slice(i, i + 40);
    const list = chunk.map((d) => `'${esc(d)}'`).join(",");
    const rows = await queryAll(ENTITY[kind], `where DocNumber IN (${list})`);
    for (const r of rows) found.add(r.DocNumber);
  }
  return found;
}

export async function findDoc(kind: Kind, order: string): Promise<QDoc | null> {
  const dn = docNumberFor(kind, order);
  const rows = await queryAll(ENTITY[kind], `where DocNumber = '${esc(dn)}'`);
  if (!rows.length) return null;
  if (rows.length > 1) throw new Error(`More than one ${ENTITY[kind]} has the number “${dn}”. Check QuickBooks.`);
  const items = await listItems();
  return view(kind, rows[0], items);
}

/** Re-read straight from QuickBooks (used to verify after a save). */
export async function reread(kind: Kind, id: string): Promise<QDoc> {
  const j = await api(`${PATH[kind]}/${id}`);
  return view(kind, j[ENTITY[kind]], await listItems());
}

// ---------------------------------------------------------------- changes (approved fixes only)
export type FixPlan = {
  /** tax: leave, set the total tax to a number, or remove tax (all lines non-taxable) */
  tax?: { mode: "set"; total: number } | { mode: "remove" };
  /** tax amount to be entered by hand later: new lines are made taxable, but no tax figure is sent */
  taxByHand?: boolean;
  /** make the shipping line (by its QuickBooks item) non-taxable so QuickBooks recalculates a lower tax */
  untaxItemId?: string;
  /** lines to add (QBO item already chosen) */
  addLines?: { itemId: string; qty: number; rate: number; amount: number; description?: string }[];
  /** replace ALL item and discount lines with these (Woo's lines); discount:true lines become discount lines */
  replaceLines?: { itemId: string; qty: number; rate: number; amount: number; description?: string; discount?: boolean }[];
};

export async function applyFix(doc: QDoc, plan: FixPlan): Promise<void> {
  assertWritable();
  const raw = doc.raw;
  const body: any = { Id: doc.id, SyncToken: doc.syncToken, sparse: true };
  let lines: any[] = (raw.Line || []).filter((l: any) => l.DetailType !== "SubTotalLineDetail");
  // new lines are taxable when the receipt is meant to carry tax (a tax plan other than "remove", or tax already on it)
  const newCode = plan.tax?.mode === "remove" ? "NON" : plan.tax || plan.taxByHand || doc.tax > 0 ? "TAX" : "NON";
  const itemLine = (a: { itemId: string; qty: number; rate: number; amount: number; description?: string }) => ({
    DetailType: "SalesItemLineDetail", Amount: a.amount, Description: a.description,
    SalesItemLineDetail: { ItemRef: { value: a.itemId }, Qty: a.qty, UnitPrice: a.rate, TaxCodeRef: { value: newCode } },
  });

  if (plan.replaceLines) {
    lines = lines.filter((l: any) => l.DetailType !== "SalesItemLineDetail" && l.DetailType !== "DiscountLineDetail");
    for (const a of plan.replaceLines)
      lines.push(a.discount ? { DetailType: "DiscountLineDetail", Amount: a.amount, Description: a.description, DiscountLineDetail: { PercentBased: false } } : itemLine(a));
  }
  for (const a of plan.addLines || []) lines.push(itemLine(a));
  if (plan.untaxItemId) {
    const i = lines.findIndex((l) => l.DetailType === "SalesItemLineDetail" && l.SalesItemLineDetail?.ItemRef?.value === plan.untaxItemId);
    if (i >= 0) lines[i] = { ...lines[i], SalesItemLineDetail: { ...lines[i].SalesItemLineDetail, TaxCodeRef: { value: "NON" } } };
  }
  if (plan.tax?.mode === "remove") {
    lines = lines.map((l) => (l.DetailType === "SalesItemLineDetail" ? { ...l, SalesItemLineDetail: { ...l.SalesItemLineDetail, TaxCodeRef: { value: "NON" } } } : l));
    body.TxnTaxDetail = { TotalTax: 0 };
  } else if (plan.tax?.mode === "set") {
    // a manual tax amount is only considered when at least one line is taxable
    const anyTaxable = lines.some((l) => l.DetailType === "SalesItemLineDetail" && l.SalesItemLineDetail?.TaxCodeRef?.value && l.SalesItemLineDetail.TaxCodeRef.value !== "NON");
    if (!anyTaxable) lines = lines.map((l) => (l.DetailType === "SalesItemLineDetail" ? { ...l, SalesItemLineDetail: { ...l.SalesItemLineDetail, TaxCodeRef: { value: "TAX" } } } : l));
    body.TxnTaxDetail = { ...(raw.TxnTaxDetail || {}), TotalTax: plan.tax.total };
  }
  body.Line = lines;
  await api(PATH[doc.kind], body);
}


// ---------------------------------------------------------------- rollback and failure reasons
/** Put a receipt back to what it was before a fix: its original lines and tax detail. Returns the receipt as re-read. */
export async function restore(kind: Kind, id: string, original: any): Promise<QDoc> {
  assertWritable();
  const cur = await reread(kind, id);
  // lines go back without their old ids (the fix may have deleted those lines), so QuickBooks creates them again
  const lines = (original.Line || []).filter((l: any) => l.DetailType !== "SubTotalLineDetail").map((l: any) => { const { Id, LineNum, ...rest } = l; return rest; });
  const body: any = { Id: id, SyncToken: cur.syncToken, sparse: true, Line: lines };
  if (original.TxnTaxDetail) body.TxnTaxDetail = original.TxnTaxDetail;
  await api(PATH[kind], body);
  return reread(kind, id);
}

/** A short, plain reason for a failed fix, from QuickBooks's message or from what the re-read showed. */
export function explainFailure(err: unknown, ctx?: { taxStillWrong?: boolean; totalStillWrong?: boolean; linesStillWrong?: boolean }): string {
  const m = err instanceof Error ? err.message : String(err ?? "");
  if (/activate this item|inactive/i.test(m)) return "A QuickBooks item on the receipt is inactive.";
  if (/stale|syncToken/i.test(m)) return "Someone changed the receipt while the fix was running. Run the check again.";
  if (/period|closing date|closed/i.test(m)) return "The accounting period is closed for this date.";
  if (/amount is not equal to unitprice/i.test(m)) return "A line's amount does not equal price times quantity.";
  if (/not connected|connect/i.test(m)) return "QuickBooks is not connected.";
  if (/writes|ALLOW_PRODUCTION/i.test(m)) return "Saving to the real company is switched off.";
  if (m) return m.length > 160 ? m.slice(0, 160) + "…" : m;
  if (ctx?.taxStillWrong) return "QuickBooks did not take the new tax amount.";
  if (ctx?.totalStillWrong || ctx?.linesStillWrong) return "The receipt still differs from Woo after saving.";
  return "Unknown.";
}


/** Where to open a receipt in the QuickBooks web app. */
export function qbLink(kind: Kind, id: string): string {
  const host = ENV === "sandbox" ? "https://app.sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com";
  return `${host}/app/${kind === "sale" ? "salesreceipt" : "refundreceipt"}?txnId=${encodeURIComponent(id)}`;
}
