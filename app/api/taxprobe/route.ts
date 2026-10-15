// SANDBOX ONLY. Tries different ways of setting a manual tax amount on one test receipt.
import { handler } from "@/lib/route";
import { probeTax } from "@/lib/qb";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = handler(async (req: Request) => {
  const { order, tax } = await req.json();
  if (!/^\d+$/.test(String(order)) || !Number.isFinite(Number(tax))) throw new Error("Enter an order number and a tax amount.");
  return { log: await probeTax(String(order), Number(tax)) };
});
