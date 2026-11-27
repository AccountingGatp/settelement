# Settlement Reconciliation

Upload the settlement file (the Authorize.net download or the team's `AuthorizeNet_<day>_output` workbook). For every order the tool finds the
receipt in QuickBooks Online, compares it with the file, corrects the sales tax, and gives back the output workbook.
There is no WooCommerce connection and no database; nothing is saved on any server.

## The rule (from the team's SOP video)
- Column **L** of the output file (the file's tax, "Order Total Tax Amount") is the truth. QuickBooks tax (**M**) must equal it, so **TaxDiff = L − M = 0**.
- When the settlement has zero tax, the direct override uses 0.00.
- If tax differs, set QuickBooks total tax directly to the file’s tax, including when the receipt contains shipping.
- QuickBooks tax is lower or missing: total tax is set to the file's tax.
- The uploaded Line Amount (F) and File Amount (J) are compared separately with the live QuickBooks total. File Amount remains the target when both columns exist. A check or re-upload reads each receipt by ID. Verify and download Excel repeats that read for every row and puts the live figures on main. The Changes sheet records the uploaded line, its difference, and the receipt ID and read time. An attempted fix is verified by a separate receipt read and restored if verification fails and the receipt version still matches.
- Sales differences before tax require review. A refund with a known tax amount can use the approved adjustment item to post a pre-tax difference.
- Orders not found in QuickBooks are never created: they are listed in a popup, left as they are, and shown as "Not found" in the output.
- Fix and Fix All include refunds when the source provides the refunded tax. Signed refund tax in the team workbook is recognized. For a pre-tax refund difference, set `QB_REFUND_ADJUSTMENT_ITEM` to the exact name of the approved active service or non-inventory item in QuickBooks. The tool posts the difference on that item as non-taxable and verifies the resulting refund. Use a populated refund transaction’s `L2 - Tax` in the expanded Authorize.net export or the `Refund Tax Amount` column in a workbook. Use an explicit zero for a tax-free refund. A workbook can also use the sale’s tax for a full refund when it contains one matching sale and one refund for the same order and amount.
- A match requires zero difference in both the receipt total and the tax, to the cent.

## Settings (Vercel → Environment Variables)
See `.env.example`. Only these are used: `APP_PASSWORD`, `SESSION_SECRET`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_ENVIRONMENT`, `QB_REDIRECT_URI`, `DOC_PREFIX_SALE`, `DOC_PREFIX_REFUND`, `ALLOW_PRODUCTION_WRITES`, `DEPOSIT_ACCOUNT`, `QB_REFUND_ADJUSTMENT_ITEM`, `TAX_OVERRIDE_API`.
You can delete `WOO_*`, `SUPABASE_*`, `KV_*`, `UPSTASH_*` and `TAX_VIA_API`.

## QuickBooks login
The login is kept in an encrypted cookie in each person's own browser (about 100 days). Each person clicks **Connect to QuickBooks** once in their browser.
If the cookie is cleared, connect again.

## First test on the real company
1. `QB_ENVIRONMENT=production`, production keys, `ALLOW_PRODUCTION_WRITES=no`. Connect, upload the file, run the check. Nothing is changed.
2. Set `ALLOW_PRODUCTION_WRITES=yes`, fix one receipt, open it in QuickBooks and confirm. Then use Fix all.
3. The app tries supported tax payloads on each receipt and verifies the saved total and tax. It attempts to restore the original receipt if every correction fails. Fix All continues with other receipts and records the outcome in the Failed tab. Set `TAX_OVERRIDE_API=no` to disable exact-tax overrides.
4. The workflow opens Fixes needed after the check and advances to Failed, Review needed, or Download as each queue clears.

## Develop
`npm install`, `npm test`, `npm run dev`.
