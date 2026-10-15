// QuickBooks Online connection + the API calls this tool needs (read receipts, update them, seed the sandbox).
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
  const newCode = plan.tax?.mode === "remove" ? "NON" : plan.tax || doc.tax > 0 ? "TAX" : "NON";
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

// ---------------------------------------------------------------- sandbox seeding
export async function incomeAccountId(): Promise<string> {
  const key = `qb:income:${ENV}`;
  const cached = await kvGet<string>(key);
  if (cached) return cached;
  const accts = await queryAll("Account", "where Active = true");
  const a = accts.find((x) => x.AccountSubType === "SalesOfProductIncome") || accts.find((x) => x.AccountType === "Income");
  if (!a) throw new Error("No income account found in the QuickBooks company.");
  await kvSet(key, a.Id);
  return a.Id;
}

export async function ensureItem(name: string, sku: string): Promise<QItem> {
  const items = await listItems();
  const hit = (sku && items.find((i) => i.sku && i.sku.toLowerCase() === sku.toLowerCase())) || items.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (hit) {
    if (hit.active) return hit;
    assertWritable(); // sandbox seeding only: switch an inactive item back on so it can be used
    const cur = (await api(`item/${hit.id}`)).Item;
    await api("item", { Id: cur.Id, SyncToken: cur.SyncToken, Active: true, sparse: true });
    itemCache = null;
    return { ...hit, active: true };
  }
  assertWritable();
  const j = await api("item", { Name: name.slice(0, 100), Sku: sku || undefined, Type: "Service", IncomeAccountRef: { value: await incomeAccountId() }, Taxable: false });
  const it: QItem = { id: j.Item.Id, name: j.Item.Name, sku: j.Item.Sku || "", type: j.Item.Type, active: true };
  itemCache = null;
  return it;
}

export async function ensureCustomer(name: string): Promise<string> {
  const rows = await queryAll("Customer", `where DisplayName = '${esc(name)}'`);
  if (rows[0]) return rows[0].Id;
  assertWritable();
  return (await api("customer", { DisplayName: name })).Customer.Id;
}

export async function createReceipt(kind: Kind, p: { docNumber: string; customerId: string; date: string; lines: { itemId: string; qty: number; rate: number; amount: number }[]; totalTax: number }): Promise<QDoc> {
  assertWritable();
  const j = await api(PATH[kind], {
    DocNumber: p.docNumber, TxnDate: p.date, CustomerRef: { value: p.customerId },
    Line: p.lines.map((l) => ({
      DetailType: "SalesItemLineDetail", Amount: l.amount,
      SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: l.qty, UnitPrice: l.rate, TaxCodeRef: { value: p.totalTax > 0 ? "TAX" : "NON" } },
    })),
    TxnTaxDetail: { TotalTax: p.totalTax },
  });
  return view(kind, j[ENTITY[kind]], await listItems());
}

// ---------------------------------------------------------------- tax probe (SANDBOX ONLY)
/** Tries several ways of sending a manual tax amount to one sandbox receipt and reports what QuickBooks did with each. */
export async function probeTax(order: string, target: number): Promise<string[]> {
  if (ENV !== "sandbox") throw new Error("The tax test only runs on the sandbox company.");
  assertWritable();
  const out: string[] = [];
  const first = await findDoc("sale", order);
  if (!first) throw new Error(`Receipt for order ${order} was not found in the sandbox.`);
  try {
    const p = (await api("preferences")).Preferences?.TaxPrefs || {};
    out.push(`Company tax settings: UsingSalesTax=${p.UsingSalesTax}, PartnerTaxEnabled=${p.PartnerTaxEnabled} (true means QuickBooks calculates tax itself)`);
  } catch (e) { out.push(`Could not read tax settings: ${e instanceof Error ? e.message : e}`); }
  const codes = (await queryAll("TaxCode", "")).filter((c: any) => !["TAX", "NON"].includes(c.Name) && c.SalesTaxRateList?.TaxRateDetail?.[0]);
  const code = codes[0];
  out.push(code ? `Tax code used for the variants: ${code.Name} (id ${code.Id}), rate id ${code.SalesTaxRateList.TaxRateDetail[0].TaxRateRef.value}` : "No named tax code with a rate exists in this company; variants 2 and 3 are skipped.");
  out.push(`Before: total ${first.total}, tax ${first.tax}. Target tax: ${target}`);

  const variants: { name: string; detail: (net: number) => any | null }[] = [
    { name: "1. TotalTax only", detail: () => ({ TotalTax: target }) },
    { name: "2. TotalTax + tax code + tax line", detail: (net) => code && ({ TxnTaxCodeRef: { value: code.Id }, TotalTax: target, TaxLine: [{ Amount: target, DetailType: "TaxLineDetail", TaxLineDetail: { TaxRateRef: { value: code.SalesTaxRateList.TaxRateDetail[0].TaxRateRef.value }, PercentBased: false, NetAmountTaxable: net } }] }) },
    { name: "3. Tax code + tax line, no TotalTax", detail: (net) => code && ({ TxnTaxCodeRef: { value: code.Id }, TaxLine: [{ Amount: target, DetailType: "TaxLineDetail", TaxLineDetail: { TaxRateRef: { value: code.SalesTaxRateList.TaxRateDetail[0].TaxRateRef.value }, PercentBased: false, NetAmountTaxable: net } }] }) },
  ];
  for (const v of variants) {
    try {
      const doc = await reread("sale", first.id);
      const lines = (doc.raw.Line || []).filter((l: any) => l.DetailType !== "SubTotalLineDetail").map((l: any) =>
        l.DetailType === "SalesItemLineDetail" ? { ...l, SalesItemLineDetail: { ...l.SalesItemLineDetail, TaxCodeRef: { value: "TAX" } } } : l);
      const net = round2(lines.filter((l: any) => l.DetailType === "SalesItemLineDetail").reduce((s: number, l: any) => s + Number(l.Amount || 0), 0));
      const detail = v.detail(net);
      if (!detail) { out.push(`${v.name}: skipped (no tax code)`); continue; }
      await api(PATH.sale, { Id: doc.id, SyncToken: doc.syncToken, sparse: true, Line: lines, TxnTaxDetail: detail });
      const after = await reread("sale", doc.id);
      out.push(`${v.name}: saved. total ${after.total}, tax ${after.tax}${Math.abs(after.tax - target) < 0.011 ? "  <-- WORKS" : ""}`);
      if (Math.abs(after.tax - target) < 0.011) break;
    } catch (e) { out.push(`${v.name}: refused. ${e instanceof Error ? e.message : e}`); }
  }
  return out;
}
