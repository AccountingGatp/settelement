// SANDBOX ONLY. Creates test receipts in the QuickBooks sandbox that look like the old, wrong ones for real Woo orders,
// so the checker and the fixes can be tried without touching real books.
import { handler } from "@/lib/route";
import { SNAPSHOTS } from "@/seed/snapshots";
import { getOrder } from "@/lib/woo";
import { createReceipt, docNumberFor, ensureCustomer, ensureItem, ENV, findDoc } from "@/lib/qb";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = handler(async (req: Request) => {
  const day = new URL(req.url).searchParams.get("day") || "";
  const rows = (SNAPSHOTS[day] || []).filter((r) => r.type === "sale");
  return { day, orders: rows.map((r) => r.order), days: Object.keys(SNAPSHOTS) };
});

export const POST = handler(async (req: Request) => {
  if (ENV !== "sandbox") throw new Error("Seeding only works on the sandbox company. QB_ENVIRONMENT is not “sandbox”.");
  const { day, order } = await req.json();
  const s = (SNAPSHOTS[day] || []).find((r) => r.order === String(order) && r.type === "sale");
  if (!s) throw new Error("Order not in the snapshot.");
  if (await findDoc("sale", s.order)) return { order: s.order, skipped: true, message: "Already exists in the sandbox." };
  const woo = await getOrder(s.order);
  if (!woo) throw new Error(`Order ${s.order} was not found in WooCommerce.`);

  // what the old QuickBooks receipt was missing before tax; drop the Woo line of that size so the sandbox receipt is short by the same amount
  const gap = r2((s.settle - s.wooTax) - (s.qboTotal - s.qboTax));
  const usable = woo.lines.filter((l) => l.amount > 0);
  let omitted = "";
  const drop = gap > 0.01 ? usable.find((l) => l.kind !== "item" && Math.abs(l.amount - gap) < 0.011) || usable.find((l) => Math.abs(l.amount - gap) < 0.011) : undefined;
  const lines: { itemId: string; qty: number; rate: number; amount: number }[] = [];
  for (const l of usable) {
    if (l === drop) { omitted = `${l.name} (${l.amount.toFixed(2)})`; continue; }
    const it = await ensureItem(l.name, l.sku);
    lines.push({ itemId: it.id, qty: l.qty, rate: r2(l.amount / (l.qty || 1)), amount: l.amount });
  }
  const made = await createReceipt("sale", { docNumber: docNumberFor("sale", s.order), customerId: await ensureCustomer("Seed Customer"), date: s.date, lines, totalTax: s.qboTax });
  return {
    order: s.order, skipped: false, omitted, wanted: { total: s.qboTotal, tax: s.qboTax }, got: { total: made.total, tax: made.tax },
    matchesOld: Math.abs(made.total - s.qboTotal) < 0.011 && Math.abs(made.tax - s.qboTax) < 0.011,
  };
});
