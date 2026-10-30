# Settlement Reconciliation

Upload the settlement file (the Authorize.net download or the team's `AuthorizeNet_<day>_output` workbook). For every order the tool finds the
receipt in QuickBooks Online, compares it with the file, corrects the sales tax, and gives back the output workbook.
There is no WooCommerce connection and no database; nothing is saved on any server.

## The rule (from the team's SOP video)
- Column **L** of the output file (the file's tax, "Order Total Tax Amount") is the truth. QuickBooks tax (**M**) must equal it, so **TaxDiff = L − M = 0**.
- File has no tax, QuickBooks has: tax is removed (Taxable unticked on every line).
- QuickBooks tax is higher, usually because shipping was taxed: shipping is made non-taxable if that gives exactly the file's tax; otherwise the total tax is set to the file's tax.
- QuickBooks tax is lower or missing: total tax is set to the file's tax.
- The receipt total (**F**, "Line Amount") follows the new tax. Each fix is saved, re-read from QuickBooks and compared again; if it does not match, the receipt is put back.
- If the difference is more than tax (a line is missing or wrong), nothing is changed and the row is listed for a person.
- Orders not found in QuickBooks are never created: they are listed in a popup, left as they are, and shown as "Not found" in the output.
- Refunds are checked but not changed automatically.

## Settings (Vercel → Environment Variables)
See `.env.example`. Only these are used: `APP_PASSWORD`, `SESSION_SECRET`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_ENVIRONMENT`, `QB_REDIRECT_URI`, `DOC_PREFIX_SALE`, `DOC_PREFIX_REFUND`, `ALLOW_PRODUCTION_WRITES`, `DEPOSIT_ACCOUNT`.
You can delete `WOO_*`, `SUPABASE_*`, `KV_*`, `UPSTASH_*` and `TAX_VIA_API`.

## QuickBooks login
The login is kept in an encrypted cookie in each person's own browser (about 100 days). Each person clicks **Connect to QuickBooks** once in their browser.
If the cookie is cleared, connect again.

## First test on the real company
1. `QB_ENVIRONMENT=production`, production keys, `ALLOW_PRODUCTION_WRITES=no`. Connect, upload the file, run the check. Nothing is changed.
2. Set `ALLOW_PRODUCTION_WRITES=yes`, fix one receipt, open it in QuickBooks and confirm. Then use Fix all.
3. If QuickBooks will not take a tax amount through its API, the row shows **Tax to enter by hand** with the figure (Edit sales tax → enter it → Apply override → Save), then **Check again**.

## Develop
`npm install`, `npm test`, `npm run dev`.
