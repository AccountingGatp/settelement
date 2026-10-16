# Settlement Reconciliation

Upload the Authorize.net settlement download → the tool checks every settled sale and credited refund against
WooCommerce (reference) and QuickBooks Online → shows what differs → after approval it corrects QuickBooks and
re-reads each receipt to prove it now matches Woo.

## What it does
| Step | What happens |
|---|---|
| 1 Upload | Keeps **Settled Successfully** (sales) and **Credited** (refunds). Declined, Voided and rows without an order number are listed as skipped. A popup lists any order that is **not found in QuickBooks** (those are never created). |
| 2 Check (no changes) | For each row: reads the Woo order/refund and the QBO receipt (`Woo Order#<n>` / `Woo Refund#<n>`), compares total, tax and lines, and decides: **Matched**, **Needs fix**, **Pending review**, **Not found**. Receipts already in a bank deposit are flagged **In deposit**. |
| 3 Fix | Only rows where every difference has an automatic fix: remove tax, set total tax to Woo's tax, add a missing line (needs a matching QBO item). The server re-computes the plan, saves, re-reads and compares again. A row is **Corrected, verified** only if QBO then equals Woo. |
| Report | Excel download with before/after values, planned changes and reasons for review. |

Goes to **Pending review** (never changed): a Woo total that differs from the settlement, a wrong price/quantity/discount, an extra QBO line, a missing line with no matching QBO item, any amount no line explains, an unmatched refund.

## Deploy on Vercel
(Sharing an Upstash database with another project is fine: every key here starts with `recon:`.)
1. New Vercel project from this folder/repo. Storage: in Supabase run `supabase.sql` once (SQL Editor), then set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the service_role key, server only). Or use Upstash Redis instead (`KV_REST_API_URL` / `KV_REST_API_TOKEN`).
2. **Settings → Environment Variables** (see `.env.example`): `APP_PASSWORD`, `SESSION_SECRET`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`,
   `QB_ENVIRONMENT=sandbox`, `QB_REDIRECT_URI=https://<your-app>.vercel.app/api/qb/callback`, `WOO_URL`, `WOO_KEY`, `WOO_SECRET`.
3. Intuit app → **Development** → Redirect URIs → add the same `QB_REDIRECT_URI`.
4. Redeploy, log in, **Connect to QuickBooks** (pick the sandbox company).

## Test on production (read-only first)
Set `QB_ENVIRONMENT=production`, production keys and the Production redirect URI, keep `ALLOW_PRODUCTION_WRITES=no`, upload the file and run the check. Set it to `yes` only when ready to fix one receipt.
2. Upload `9_sep_download.xlsx` → popup should list nothing missing → **Run the check**.
3. Compare the planned fixes with the old output sheet. Fix **one** receipt, open it in QuickBooks, confirm.
4. **Fix all that are ready**, then download the report.

## Going live (later)
Switch to Production keys, `QB_ENVIRONMENT=production`, and connect the real company. Writes to a real company stay **blocked** until
`ALLOW_PRODUCTION_WRITES=yes` is set on purpose. First run it read-only and compare with what the team would do by hand.

## Tax: what is automatic and what is by hand
- **Woo has no tax, QuickBooks has tax:** the lines are set to non-taxable through the API (not yet proven on the real company; fix one receipt first).
- **Both have tax, QuickBooks higher, Woo does not tax shipping (the usual case):** the shipping line is made non-taxable through the API, so QuickBooks recalculates tax down to Woo's figure. The row is verified afterwards; if the tax still differs it falls back to by hand.
- **Any other tax difference (Woo has tax and QuickBooks none, or shipping is not the cause):** the sandbox test showed QuickBooks calculates tax itself and ignores an amount sent through the API. So the app fixes amounts and lines automatically, then shows **Tax to enter by hand** with the figure and an **Open in QuickBooks** link. After you enter it (Edit sales tax, enter manually, apply) click **Check again**; the row turns **Matched** when QuickBooks tax equals Woo tax.
- Set `TAX_VIA_API=yes` only if a test proves the API takes the amount.

## Known unknowns (find out on the sandbox)
- Whether the QuickBooks API honours a manually set tax total on an automatically calculated receipt. If not, saved receipts will fail verification and show **Failed**; tax fixes would then need browser automation.
- Document numbers: assumes `Woo Order#<n>` and `Woo Refund#<n>` (change `DOC_PREFIX_*` if different).

## Local
```
npm install
cp .env.example .env.local
npm test     # logic tests (optional: DL_0908=... DL_0909=... to test the file reader on the real downloads)
npm run dev  # http://localhost:8000
```
