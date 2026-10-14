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
1. New Vercel project from this folder/repo. **Storage** → add **Upstash (Redis)** (sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`).
2. **Settings → Environment Variables** (see `.env.example`): `APP_PASSWORD`, `SESSION_SECRET`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`,
   `QB_ENVIRONMENT=sandbox`, `QB_REDIRECT_URI=https://<your-app>.vercel.app/api/qb/callback`, `WOO_URL`, `WOO_KEY`, `WOO_SECRET`.
3. Intuit app → **Development** → Redirect URIs → add the same `QB_REDIRECT_URI`.
4. Redeploy, log in, **Connect to QuickBooks** (pick the sandbox company).

## Test on the sandbox (development keys)
1. On the page, **Sandbox only: create test receipts** → pick 9 Sep → creates sandbox receipts for the real Woo orders with the same wrong totals/tax the old books had. Read the log: it says whether QuickBooks accepted the tax value.
2. Upload `9_sep_download.xlsx` → popup should list nothing missing → **Run the check**.
3. Compare the planned fixes with the old output sheet. Fix **one** receipt, open it in QuickBooks, confirm.
4. **Fix all that are ready**, then download the report.

## Going live (later)
Switch to Production keys, `QB_ENVIRONMENT=production`, and connect the real company. Writes to a real company stay **blocked** until
`ALLOW_PRODUCTION_WRITES=yes` is set on purpose. First run it read-only and compare with what the team would do by hand.

## Known unknowns (find out on the sandbox)
- Whether the QuickBooks API honours a manually set tax total on an automatically calculated receipt. If not, saved receipts will fail verification and show **Failed**; tax fixes would then need browser automation.
- Document numbers: assumes `Woo Order#<n>` and `Woo Refund#<n>` (change `DOC_PREFIX_*` if different).
- Seeding refunds is not included yet.

## Local
```
npm install
cp .env.example .env.local
npm test     # logic tests (optional: DL_0908=... DL_0909=... to test the file reader on the real downloads)
npm run dev  # http://localhost:8000
```
