export default function Privacy() {
  return (
    <main className="doc">
      <h1>Privacy</h1>
      <p>This Settlement Reconciliation tool is an internal tool operated by GATP Solutions for its own bookkeeping staff. It is not offered to the public.</p>
      <p><b>What it accesses.</b> With the permission of an authorized QuickBooks user, the tool reads sales receipt, refund receipt, item and deposit records and, when a person approves a change, updates sales receipts and refund receipts in the connected QuickBooks Online company.</p>
      <p><b>Storage.</b> The tool has no database. The QuickBooks connection is kept in an encrypted cookie in the user&apos;s own browser and is removed with Disconnect. Uploaded settlement files are processed in memory and are not kept.</p>
      <p><b>Sharing.</b> Data is not sold or shared with third parties.</p>
    </main>
  );
}
