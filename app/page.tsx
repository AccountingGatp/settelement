"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseSettlement, type Row } from "@/lib/settlement";

import type { Verdict } from "@/lib/recon";

type Result = Verdict & { final?: string; before?: Verdict; error?: string; message?: string; reason?: string; tried?: string[] };
const tabs = ["Fixes needed", "Failed", "Review needed", "Matched", "Corrected", "Download"] as const;
type Tab = typeof tabs[number];

function tabFor(result: Result): Tab {
  if (result.error || result.final === "Failed") return "Failed";
  if (result.final === "Skipped") return "Review needed";
  if (result.status === "Needs fix" && !result.final) return "Fixes needed";
  if (result.final === "Corrected, verified") return "Corrected";
  if (result.status === "Matched") return "Matched";
  return "Review needed";
}

type ReadOut = {
  rows: Row[]; skipped: { txnId: string; order: string; status: string; amount: number; reason: string }[]; problems: string[];
  counts: Record<string, number>; missingInQbo: { order: string; type: string; docNumber: string }[]; prefix?: Record<string, string>; notes?: string[]; similar?: { type: string; docNumber: string; date: string; total: number; customer: string }[]; lookedFor?: string;
};
type St = { connected: boolean; companyName: string; environment: string; writesAllowed: boolean };

const money = (n?: number | null) => n == null ? "–" : n.toFixed(2);
const key = (r: Row) => JSON.stringify([r.type, r.order, r.txnId, r.docNumber, r.amount, r.date]);
const chipClass = (s: string) => s.split(/[ ,]/)[0];
async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `Error ${r.status}`);
  return j;
}
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, stop: () => boolean) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && !stop()) { const x = items[i++]; await fn(x); } }));
}

export default function Home() {
  const [st, setSt] = useState<St | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [read, setRead] = useState<ReadOut | null>(null);
  const [popup, setPopup] = useState(false);
  const [res, setRes] = useState<Record<string, Result>>({});
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [fileName, setFileName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const cancel = useRef(false);
  const [fixing, setFixing] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    fetch("/api/qb/status").then((r) => r.json()).then(setSt).catch(() => {});
    const e = new URLSearchParams(location.search).get("error");
    if (e) setErr(e);
  }, []);

  async function upload(f: File) {
    setErr(""); setRead(null); setRes({}); setBusy("Reading settlement file…"); setTab(null); setFileName(f.name); setOpen(null); setPopup(false);
    try {
      // The file is read here in the browser (the output workbooks are over 5 MB, more than the server accepts);
      // only the small list of rows goes to the server.
      if (!/\.(xlsx|xls|csv)$/i.test(f.name)) throw new Error("Please choose an .xlsx or .csv file.");
      const settlement = parseSettlement(await f.arrayBuffer());
      const r = await fetch("/api/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settlement }) });
      const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
      if (!r.ok || j.error) throw new Error(j.error || "Could not read the file.");
      setRead(j);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy("");
  }

  const withPrefix = (row: Row) => (read?.prefix && read.prefix[row.type] !== undefined ? { ...row, prefix: read.prefix[row.type] } : row);

  async function runChecks() {
    if (!read) return;
    cancel.current = false; setErr(""); setRes({}); setTab(null);
    let done = 0;
    setProgress({ done, total: read.rows.length, label: "Checking against QuickBooks" });
    await pool(read.rows, 2, async (row) => {
      try {
        const v = (await post("/api/check", { row: withPrefix(row) })) as Verdict;
        setRes((p) => ({ ...p, [key(row)]: v }));
      } catch (e) {
        setRes((p) => ({ ...p, [key(row)]: { ...(blankFor(row)), error: e instanceof Error ? e.message : String(e) } }));
      }
      setProgress({ done: ++done, total: read.rows.length, label: "Checking against QuickBooks" });
    }, () => cancel.current);
    setProgress(null);
  }

  function blankFor(row: Row): Result {
    return { order: row.order, type: row.type, customer: row.customer, status: "Pending review", scenario: "-", lineAmount: row.lineAmount, settle: Math.abs(row.amount), fileTax: row.fileTax, qboTotal: 0, qboTax: 0, taxDiff: null, totalDiff: 0, inDeposit: false, issues: [], plan: {}, blockers: [], notes: [] };
  }

  async function fixOne(row: Row) {
    const k = key(row);
    try {
      const j = await post("/api/fix", { row: withPrefix(row) });
      const fin = j.verified ? "Corrected, verified" : j.failed ? "Failed" : undefined;
      setRes((p) => ({
        ...p,
        [k]: {
          ...j.after, before: j.verified || j.applied ? j.before : undefined, final: fin || undefined,
          message: j.message, reason: j.reason, link: j.link || j.after.link, tried: j.tried, taxToEnter: j.taxToEnter,
        },
      }));
    } catch (e) {
      setRes((p) => ({ ...p, [k]: { ...p[k], final: "Failed", error: e instanceof Error ? e.message : String(e) } }));
    }
  }

  async function fixSingle(row: Row) {
    setFixing(true);
    setTab(null);
    try { await fixOne(row); }
    finally { setFixing(false); }
  }

  async function recheckOne(row: Row) {
    const k = key(row);
    setFixing(true);
    setTab(null);
    try {
      const v = (await post("/api/check", { row: withPrefix(row) })) as Verdict;
      setRes((p) => {
        const previous = p[k];
        if (previous?.final === "Failed" && previous.tried) {
          if (v.status === "Matched" || (v.status === "Line amount differs" && v.receiptId === previous.receiptId)) {
            return { ...p, [k]: { ...v, before: previous.before ?? previous, final: "Corrected, verified" } };
          }
          if (v.status === "Needs fix") {
            return { ...p, [k]: { ...v, before: previous.before, final: "Failed", message: previous.message,
              reason: previous.reason, tried: previous.tried, taxToEnter: previous.taxToEnter } };
          }
        }
        return { ...p, [k]: v };
      });
    } catch (e) {
      setRes((p) => ({ ...p, [k]: { ...p[k], final: "Failed", error: e instanceof Error ? e.message : String(e) } }));
    } finally { setFixing(false); }
  }

  function skipOne(row: Row, on: boolean) {
    const k = key(row);
    setTab(null);
    setRes((p) => ({ ...p, [k]: { ...p[k], final: on ? "Skipped" : undefined } }));
  }

  async function fixAll() {
    if (!read) return;
    const todo = read.rows.filter((r) => res[key(r)]?.status === "Needs fix" && !res[key(r)]?.final);
    if (!todo.length) return;
    if (!confirm(`Apply the planned fix to ${todo.length} receipt(s) in QuickBooks?\n\nEach one is re-checked, saved and verified.`)) return;
    cancel.current = false; setErr(""); setTab(null); let done = 0;
    setProgress({ done, total: todo.length, label: "Fixing" });
    await pool(todo, 1, async (row) => {
      await fixOne(row);
      setProgress({ done: ++done, total: todo.length, label: "Fixing" });
    }, () => cancel.current);
    setProgress(null);
  }

  /** Every row that is not matched or fixed, with the reason and the exact change it needs, so nothing is lost. */
  function needsPerson() {
    const q = (x: string) => `"${String(x ?? "").replace(/"/g, '""')}"`;
    const rows = Object.values(res).filter((v) => !["Matched", "Corrected"].includes(tabFor(v)));
    const head = ["Order", "Type", "Status", "File amount", "File tax", "QBO total", "QBO tax", "TaxDiff", "Change needed", "Reason"];
    const lines = rows.map((v) => [v.order, v.type, v.final || v.status, money(v.settle), money(v.fileTax), v.status === "Not found" ? "" : money(v.qboTotal), v.status === "Not found" ? "" : money(v.qboTax), v.status === "Not found" ? "" : money(v.taxDiff),
      v.final === "Skipped" ? "Skipped: " + summary({ ...v, final: undefined }) : summary(v), [v.reason, v.error, ...(v.tried || []), ...v.blockers].filter(Boolean).join(" | ")].map(q).join(","));
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([[head.map(q).join(","), ...lines].join("\n")], { type: "text/csv" })); a.download = "needs-a-person.csv"; a.click();
  }

  async function report() {
    if (!read) return;
    setErr("");
    setExporting(true);
    cancel.current = false;
    const label = "Verifying every receipt for Excel";
    const latest: Record<string, Result> = {};
    let done = 0;
    setProgress({ done, total: read.rows.length, label });
    try {
      await pool(read.rows, 2, async (row) => {
        const k = key(row), previous = res[k];
        try {
          const fresh = (await post("/api/check", { row: withPrefix(row) })) as Verdict;
          const sameReceipt = !!fresh.receiptId && fresh.receiptId === previous?.receiptId;
          const stillCorrected = sameReceipt && (fresh.status === "Matched" || fresh.status === "Line amount differs") &&
            previous?.final === "Corrected, verified";
          latest[k] = {
            ...fresh, before: previous?.before ?? (previous?.checkedAt ? previous : undefined),
            final: stillCorrected ? "Corrected, verified" : sameReceipt && previous?.final === "Skipped" && fresh.status === "Needs fix" ? "Skipped" : undefined,
            reason: previous?.final === "Corrected, verified" && !stillCorrected
              ? "A fresh QuickBooks read no longer confirms the correction." : undefined,
          };
        } catch (e) {
          latest[k] = { ...blankFor(row), error: e instanceof Error ? e.message : String(e) };
        }
        setProgress({ done: ++done, total: read.rows.length, label });
      }, () => cancel.current);
      if (cancel.current) return;
      setRes(latest);
      setTab(null);
      const r = await fetch("/api/report", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results: read.rows.map((row) => latest[key(row)]) }),
      });
      if (!r.ok) throw new Error("Could not build the report.");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = (r.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "output.xlsx";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setProgress(null); setExporting(false); }
  }

  const list = useMemo(() => (read ? read.rows.map((r) => ({ row: r, v: res[key(r)] })) : []), [read, res]);
  const label = (x: Result) => x.final || x.status;
  const groups = useMemo(() => {
    const byTab: Record<Tab, typeof list> = { "Fixes needed": [], Failed: [], "Review needed": [], Matched: [], Corrected: [], Download: [] };
    for (const entry of list) if (entry.v) byTab[tabFor(entry.v)].push(entry);
    return byTab;
  }, [list]);
  const needFix = groups["Fixes needed"]?.length ?? 0;
  const failed = groups.Failed?.length ?? 0;
  const review = groups["Review needed"]?.length ?? 0;
  const checked = Object.keys(res).length;
  const matched = groups.Matched.length;
  const corrected = groups.Corrected.length;
  const activeTab = exporting ? "Download" : progress ? "Fixes needed" : tab ??
    (needFix ? "Fixes needed" : failed ? "Failed" : review ? "Review needed" : "Download");
  const tabCounts: Record<Tab, number | null> = { "Fixes needed": needFix, Failed: failed, "Review needed": review, Matched: matched, Corrected: corrected, Download: null };
  const canFix = !!st?.writesAllowed;
  const working = !!progress || fixing;

  const renderTable = (items: { row: Row; v?: Result }[], showActions = true) => (
              <div className="table-scroll"><table>
                <thead><tr><th>Order</th><th>Type</th><th>Status</th><th className="num">File amount</th><th className="num">Uploaded line</th><th className="num">QBO total</th><th className="num">File tax</th><th className="num">QBO tax</th><th className="num">Tax diff</th><th className="num">Total diff</th><th className="num">Line diff</th><th>Details</th>{showActions && <th>Actions</th>}</tr></thead>
                <tbody>
                  {items.map(({ row, v }) => v ? (
                    <Fragment2 key={key(row)} open={open === key(row)} columns={showActions ? 13 : 12}
                      cells={<>
                        <td>{v.link ? <a className="receipt-link" href={v.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{v.order}</a> : <b>{v.order}</b>}</td><td>{v.type === "sale" ? "Sale" : "Refund"}</td>
                        <td><span className={"chip " + chipClass(label(v))}>{label(v)}</span></td>
                        <td className="num">{money(v.settle)}</td><td className="num">{money(v.lineAmount)}</td><td className="num">{v.status === "Not found" || v.error ? "–" : money(v.qboTotal)}</td>
                        <td className="num">{money(v.fileTax)}</td><td className="num">{v.status === "Not found" || v.error ? "–" : money(v.qboTax)}</td>
                        <td className="num">{v.status === "Not found" ? "–" : money(v.taxDiff)}</td>
                        <td className="num">{v.status === "Not found" || v.error ? "–" : money(v.totalDiff)}</td>
                        <td className="num">{money(v.lineDiff)}</td>
                        <td className="small">{summary(v)}
                          {showActions && (v.final === "Failed" || v.blockers.length > 0 || v.issues.length > 0 || !!v.lineDiff || !!v.reason) &&
                            <button type="button" className="link receipt-details" aria-expanded={open === key(row)}
                              onClick={() => setOpen(open === key(row) ? null : key(row))}>{open === key(row) ? "Hide details" : "View details"}</button>}
                        </td>
                        {showActions && <td className="nowrap">
                          {v.status === "Needs fix" && !v.final && <><button className="btn small" disabled={!canFix || !!progress || fixing} onClick={(e) => { e.stopPropagation(); fixSingle(row); }}>Fix</button> <button className="btn small ghost" disabled={!!progress || fixing} onClick={(e) => { e.stopPropagation(); skipOne(row, true); }}>Skip</button></>}
                          {v.final === "Skipped" && <button className="btn small ghost" disabled={!!progress || fixing} onClick={(e) => { e.stopPropagation(); skipOne(row, false); }}>Undo skip</button>}
                          {(tabFor(v) === "Failed" || (tabFor(v) === "Review needed" && v.final !== "Skipped")) && <button className="btn small" disabled={!!progress || fixing} onClick={(e) => { e.stopPropagation(); recheckOne(row); }}>Check again</button>}

                        </td>}
                      </>}
                      detail={<div>
                        {v.error && <div className="alert">{v.error}</div>}
                        {v.message && <p className="small">{v.message}</p>}
                        {v.reason && <p className="small">{v.reason}</p>}
                        {v.taxToEnter !== undefined && v.link && <p className="small">
                          Open QuickBooks and use <strong>See the math → Override this amount</strong>. Enter <strong>{money(v.taxToEnter)}</strong> for tax,
                          save the receipt, then select Check again. <a href={v.link} target="_blank" rel="noreferrer">Open receipt</a>
                        </p>}
                        {!!v.tried?.length && <ul>{v.tried.map((attempt, index) => <li key={index}>{attempt}</li>)}</ul>}
                        {v.checkedAt && <p className="small">Read from QuickBooks at {new Date(v.checkedAt).toLocaleString()}.</p>}
                        {v.inDeposit && <p className="small">Linked to a QuickBooks deposit.</p>}
                        {v.blockers.length > 0 && <><b>Needs a person because</b><ul>{v.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></>}
                        {v.issues.length > 0 && <><b>Differences</b><ul>{v.issues.map((i, n) => <li key={n}>{i.field}: File {i.file}, QuickBooks {i.qbo}. {i.note}{i.auto ? "" : " (manual)"}</li>)}</ul></>}
                        {v.before && <p className="small">Before saving, QuickBooks showed {money(v.before.qboTotal)} total and {money(v.before.qboTax)} tax.</p>}
                      </div>} />
                  ) : null)}
                </tbody>
              </table></div>
  );

  return (
    <main className="wide">
      <header>
        <h1>Settlement Reconciliation</h1>
        <div className="right">
          {st?.connected
            ? <span className="pill">{st.companyName} <em>{st.environment}</em></span>
            : <span className="pill off">QuickBooks not connected</span>}
          {st?.connected
            ? <button className="link" onClick={async () => { await post("/api/qb/disconnect", {}); location.reload(); }}>Disconnect</button>
            : <a className="btn small" href="/api/qb/connect">Connect to QuickBooks</a>}
          <button className="link" onClick={async () => { await post("/api/logout", {}); location.href = "/login"; }}>Log out</button>
        </div>
      </header>
      {err && <div className="alert">{err}</div>}
      {st?.connected && !st.writesAllowed && <div className="note">Read-only: changes to this QuickBooks company are switched off. You can still run checks.</div>}

      <section className="card">
        <h2>Upload settlement</h2>
        <label className={"drop" + (busy ? " busy" : "")}>
          {busy || <><strong>{read ? fileName : "Choose a settlement file"}</strong><span>{read ? "Click to replace the file" : "Authorize.net workbook or CSV"}</span></>}
          <input type="file" hidden accept=".xlsx,.xls,.csv" disabled={!!busy || !!progress || fixing || !st?.connected} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />
        </label>
        {!st?.connected && <p className="small muted">Connect to QuickBooks first.</p>}
        {read && (
          <>
            <p className="upload-counts">{read.rows.length} receipts · {read.rows.filter((r) => r.type === "refund").length} refunds{read.skipped.length ? ` · ${read.skipped.length} skipped` : ""}</p>
            {[...read.problems, ...(read.notes || [])].map((p, i) => <div key={i} className="note">{p}</div>)}
            {read.missingInQbo.length > 0 && <button className="link" onClick={() => setPopup(true)}>View {read.missingInQbo.length} alternate-number lookups</button>}
            <div className="upload-actions">
              <button className="btn" disabled={working || !read.rows.length} onClick={runChecks}>{checked ? "Run check again" : "Run check"}</button>
            </div>
          </>
        )}
      </section>

      {(checked > 0 || progress) && (
        <section className="card reconciliation-results">
          <div className="section-heading">
            <h2>Check against QuickBooks</h2>
            {needFix > 0 && <button className="btn" disabled={!canFix || working} onClick={fixAll}>Fix all ({needFix})</button>}
          </div>
          <nav aria-label="Reconciliation results" className="result-tabs">
            {tabs.map((name) => <button key={name} aria-current={activeTab === name ? "page" : undefined} disabled={working} onClick={() => { setTab(name); setOpen(null); }}>
              {name}{tabCounts[name] !== null && <span>{tabCounts[name]}</span>}
            </button>)}
          </nav>
          {progress && <div className="run-progress">
            <div role="progressbar" aria-label={progress.label} aria-valuenow={progress.done} aria-valuemax={progress.total} className="bar"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
            <div className="section-heading"><p className="small muted">{progress.label} · {progress.done} of {progress.total}</p><button className="link" onClick={() => { cancel.current = true; }}>Stop after current receipt</button></div>
          </div>}
          {activeTab === "Download" ? (
            <div className="download-panel">
              <h3>Download results</h3>
              <p>{corrected} corrected · {matched} matched · {failed + review + needFix} unresolved{read && read.rows.length > checked ? ` · ${read.rows.length - checked} unchecked` : ""}</p>
              <div className="row-actions">
                <button className="btn" disabled={working} onClick={report}>Verify and download Excel</button>
                {failed + review + needFix > 0 && <button className="btn ghost" disabled={working} onClick={needsPerson}>Download exceptions CSV</button>}
              </div>
            </div>
          ) : (
            <>
              {groups[activeTab]?.length ? renderTable(groups[activeTab], activeTab !== "Matched" && activeTab !== "Corrected") : !working && <p className="empty-state">No receipts in {activeTab.toLowerCase()}.</p>}
              {activeTab === "Failed" && failed > 0 && <div className="workflow-next"><button className="btn ghost small" onClick={() => setTab(review ? "Review needed" : "Download")}>{review ? "Continue to Review needed" : "Continue to Download"}</button></div>}
              {activeTab === "Review needed" && review > 0 && <div className="workflow-next"><button className="btn ghost small" onClick={() => setTab("Download")}>Continue to Download</button></div>}
            </>
          )}
        </section>
      )}

      {popup && read && (
        <div className="modal-bg" onClick={() => setPopup(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Receipt numbers to check</h2>
            <p className="small">No receipt matched the expected number for these {read.missingInQbo.length} order(s). Run the check to look for alternate receipt numbers.</p>
            {read.similar && read.similar.length > 0 && <div className="alert">Every order is missing, but QuickBooks has {read.similar.map((f) => `“${f.docNumber}”`).join(", ")} for the first order, while the app looked for “{read.lookedFor}”. The number format is different: set <b>DOC_PREFIX_SALE</b> in Vercel to the text before the order number (or <b>none</b> if there is none) and redeploy.</div>}
            <ul>{read.missingInQbo.map((m, index) => <li key={`${m.type}:${m.docNumber}:${index}`}>{m.docNumber} <span className="muted">({m.type})</span></li>)}</ul>
            <button className="btn" onClick={() => setPopup(false)}>OK, continue</button>
          </div>
        </div>
      )}
    </main>
  );
}

function summary(v: Result) {
  if (v.final === "Corrected, verified") return "Saved and verified";
  if (v.final === "Failed" || v.error) return v.error || v.message || "QuickBooks could not complete this receipt.";
  if (v.status === "Line amount differs") return "The settlement matches QuickBooks. The uploaded Line Amount differs from the current receipt total.";
  if (v.status === "Pending review" || v.status === "Not found") return v.blockers[0] || v.error || "";
  if (v.plan.adjustment) return `Adjust the pre-tax refund by ${money(v.plan.adjustment.amount)} using ${v.plan.adjustment.name}.`;
  if (!v.plan.tax) return "";
  const pv = v.plan.preview, d = pv ? pv.taxTo - pv.taxFrom : 0;
  const amt = pv ? ` Tax ${money(pv.taxFrom)} → ${money(pv.taxTo)} (${d >= 0 ? "+" : "−"}${money(Math.abs(d))}); total ${money(pv.totalFrom)} → ${money(pv.totalTo)}.` : "";
  return "Override total tax." + amt;
}

function Fragment2({ cells, detail, open, columns }: { cells: React.ReactNode; detail: React.ReactNode; open: boolean; columns: number }) {
  return (<><tr>{cells}</tr>{open && <tr className="detail"><td colSpan={columns}>{detail}</td></tr>}</>);
}
