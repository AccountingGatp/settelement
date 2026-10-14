// WooCommerce (read-only REST API). Woo is the reference for every order and refund.
export type WLine = { kind: "item" | "fee" | "shipping"; sku: string; name: string; qty: number; amount: number; tax: number };
export type WOrder = {
  order: string; status: string; total: number; tax: number; shippingTax: number; shipping: number; discount: number;
  lines: WLine[]; refunds: WRefund[];
};
export type WRefund = { id: string; total: number; tax: number; hasBreakdown: boolean };

const n = (v: unknown) => Math.round(Number(v || 0) * 100) / 100;

function base() {
  const url = (process.env.WOO_URL || "").replace(/\/+$/, "");
  const key = process.env.WOO_KEY, secret = process.env.WOO_SECRET;
  if (!url || !key || !secret) throw new Error("WooCommerce is not set up: WOO_URL, WOO_KEY and WOO_SECRET are missing in the environment.");
  return { url, auth: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64") };
}

async function get(path: string): Promise<any> {
  const { url, auth } = base();
  const r = await fetch(`${url}/wp-json/wc/v3/${path}`, { headers: { Authorization: auth, Accept: "application/json" }, cache: "no-store" });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`WooCommerce error ${r.status}: ${j.message || "request failed"}`);
  return j;
}

export function parseOrder(o: any, refunds: any[]): WOrder {
  const lines: WLine[] = [];
  for (const l of o.line_items || []) lines.push({ kind: "item", sku: l.sku || "", name: l.name || "", qty: Number(l.quantity || 1), amount: n(l.total), tax: n(l.total_tax) });
  for (const l of o.fee_lines || []) lines.push({ kind: "fee", sku: "", name: l.name || "Fee", qty: 1, amount: n(l.total), tax: n(l.total_tax) });
  for (const l of o.shipping_lines || []) lines.push({ kind: "shipping", sku: "", name: l.method_title || "Shipping", qty: 1, amount: n(l.total), tax: n(l.total_tax) });
  return {
    order: String(o.number ?? o.id), status: o.status || "", total: n(o.total), tax: n(o.total_tax),
    shippingTax: n(o.shipping_tax), shipping: n(o.shipping_total), discount: n(o.discount_total), lines,
    refunds: (refunds || []).map(parseRefund),
  };
}

export function parseRefund(r: any): WRefund {
  const parts = [...(r.line_items || []), ...(r.shipping_lines || []), ...(r.fee_lines || [])];
  const hasBreakdown = parts.length > 0;
  const tax = parts.reduce((s: number, l: any) => s + Number(l.total_tax || 0), 0);
  return { id: String(r.id), total: Math.abs(n(r.total ?? r.amount)), tax: Math.abs(n(tax)), hasBreakdown };
}

export async function getOrder(order: string): Promise<WOrder | null> {
  const o = await get(`orders/${encodeURIComponent(order)}`);
  if (!o) return null;
  const refunds = await get(`orders/${encodeURIComponent(order)}/refunds`);
  return parseOrder(o, Array.isArray(refunds) ? refunds : []);
}
