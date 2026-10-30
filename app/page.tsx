"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseSettlement } from "@/lib/settlement";

type Issue = { field: string; file: string; qbo: string; diff: number; note: string; auto: boolean };
type Verdict = {
  order: string; type: "sale" | "refund"; customer: string; status: "Matched" | "Needs fix" | "Pending review" | "Not found"; scenario: string;
  link?: string; settle: number; fileTax: number; qboTotal: number; qboTax: number; taxDiff: number; totalDiff: number; inDeposit: boolean;
  issues: Issue[]; plan: { tax?: { mode: string; total?: number }; untaxShipping?: { name: string }; preview?: { taxFrom: number; taxTo: number; totalFrom: number; totalTo: number } }; blockers: string[]; notes: string[];
};
type Row = { order: string; type: "sale" | "refund"; amount: number; fileTax: number; fileFreight: number; txnId: string; customer: string; date?: string; depositNo?: string; receivedFrom?: string };
type Result = Verdict & { final?: string; after?: Verdict; error?: string; message?: string; reason?: string; rolledBack?: boolean; link?: string; taxToEnter?: number };
type ReadOut = {
  rows: Row[]; skipped: { txnId: string; order: string; status: string; amount: number; reason: string }[]; problems: string[];
  counts: Record<string, number>; missingInQbo: { order: string; type: string; docNumber: string }[];
};
type St = { connected: boolean; companyName: string; environment: string; writesAllowed: boolean };

const money = (n: number) => n.toFixed(2);
const key = (r: { type: string; order: string }) => `${r.type}:${r.order}`;
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
  const [filter, setFilter] = useState("All");
  const [open, setOpen] = useState<string | null>(null);
  const cancel = useRef(false);

  useEffect(() => {
    fetch("/api/qb/status").then((r) => r.json()).then(setSt).catch(() => {});
    const e = new URLSearchParams(location.search).get("error");
    if (e) setErr(e);
  }, []);

  async function upload(f: File) {
    setErr(""); setRead(null); setRes({}); setBusy("Reading the file and looking up QuickBooks…");
    try {
      // The file is read here in the browser (the output workbooks are over 5 MB, more than the server accepts);
      // only the small list of rows goes to the server.
      if (!/\.(xlsx|xls|csv)$/i.test(f.name)) throw new Error("Please choose an .xlsx or .csv file.");
      const settlement = parseSettlement(await f.arrayBuffer());
      const r = await fetch("/api/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settlement }) });
      const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
      if (!r.ok || j.error) throw new Error(j.error || "Could not read the file.");
      setRead(j); if (j.missingInQbo?.length) setPopup(true);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy("");
  }

  async function runChecks() {
    if (!read) return;
    cancel.current = false; setErr(""); setRes({});
    let done = 0;
    setProgress({ done, total: read.rows.length, label: "Checking against QuickBooks" });
    await pool(read.rows, 3, async (row) => {
      try {
        const v = (await post("/api/check", { row })) as Verdict;
        setRes((p) => ({ ...p, [key(row)]: v }));
      } catch (e) {
        setRes((p) => ({ ...p, [key(row)]: { ...(blankFor(row)), error: e instanceof Error ? e.message : String(e) } }));
      }
      setProgress({ done: ++done, total: read.rows.length, label: "Checking against QuickBooks" });
    }, () => cancel.current);
    setProgress(null);
  }

  function blankFor(row: Row): Result {
    return { order: row.order, type: row.type, customer: row.customer, status: "Pending review", scenario: "-", settle: Math.abs(row.amount), fileTax: row.fileTax, qboTotal: 0, qboTax: 0, taxDiff: 0, totalDiff: 0, inDeposit: false, issues: [], plan: {}, blockers: [], notes: [] };
  }

  async function fixOne(row: Row): Promise<string> {
    const k = key(row);
    try {
      const j = await post("/api/fix", { row });
      const fin = j.verified ? "Corrected, verified" : j.manualTax ? "Tax to enter by hand" : j.refused ? "Failed" : j.applied ? "Failed, check by hand" : "";
      setRes((p) => ({ ...p, [k]: { ...j.after, plan: j.before.plan, issues: j.applied ? j.before.issues : j.after.issues, blockers: j.after.blockers, final: fin || undefined, after: j.applied ? j.after : undefined, message: j.message, reason: j.reason, rolledBack: j.rolledBack, link: j.link, taxToEnter: j.taxToEnter, taxDiff: j.applied ? j.before.taxDiff : j.after.taxDiff, qboTax: j.before.qboTax, qboTotal: j.before.qboTotal } }));
      return fin;
    } catch (e) {
      setRes((p) => ({ ...p, [k]: { ...p[k], final: "Failed", error: e instanceof Error ? e.message : String(e) } }));
      return "Failed";
    }
  }

  async function recheckOne(row: Row) {
    const k = key(row);
    try { const v = (await post("/api/check", { row })) as Verdict; setRes((p) => ({ ...p, [k]: v })); }
    catch (e) { setRes((p) => ({ ...p, [k]: { ...p[k], error: e instanceof Error ? e.message : String(e) } })); }
  }

  function skipOne(row: Row, on: boolean) {
    const k = key(row);
    setRes((p) => ({ ...p, [k]: { ...p[k], final: on ? "Skipped" : undefined } }));
  }

  async function fixAll() {
    if (!read) return;
    const todo = read.rows.filter((r) => res[key(r)]?.status === "Needs fix" && !res[key(r)]?.final);
    if (!todo.length) return;
    if (!confirm(`Apply the planned fix to ${todo.length} receipt(s) in QuickBooks?\n\nEach one is re-checked, saved and verified.`)) return;
    cancel.current = false; let done = 0;
    setProgress({ done, total: todo.length, label: "Fixing" });
    let failsInARow = 0;
    await pool(todo, 1, async (row) => {
      const f = await fixOne(row);
      setProgress({ done: ++done, total: todo.length, label: "Fixing" });
      failsInARow = f.startsWith("Failed") ? failsInARow + 1 : 0;
      if (failsInARow >= 3) { cancel.current = true; setErr("Stopped: 3 fixes in a row failed. Look at the failed rows before going on."); }
    }, () => cancel.current);
    setProgress(null);
  }

  /** Every row that is not matched or fixed, with the reason and the exact change it needs, so nothing is lost. */
  function needsPerson() {
    const q = (x: string) => `"${String(x ?? "").replace(/"/g, '""')}"`;
    const rows = Object.values(res).filter((v) => v.final !== "Corrected, verified" && v.status !== "Matched");
    const head = ["Order", "Type", "Status", "File amount", "File tax", "QBO total", "QBO tax", "TaxDiff", "Change needed", "Reason"];
    const lines = rows.map((v) => [v.order, v.type, v.final || v.status, money(v.settle), money(v.fileTax), v.status === "Not found" ? "" : money(v.qboTotal), v.status === "Not found" ? "" : money(v.qboTax), v.status === "Not found" ? "" : money(v.taxDiff),
      v.final === "Skipped" ? "Skipped: " + summary({ ...v, final: undefined }) : summary(v), [v.reason, v.error, ...v.blockers].filter(Boolean).join(" | ")].map(q).join(","));
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([[head.map(q).join(","), ...lines].join("\n")], { type: "text/csv" })); a.download = "needs-a-person.csv"; a.click();
  }

  async function report() {
    const r = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ results: (read ? read.rows : []).map((r) => res[key(r)]).filter(Boolean) }) });
    if (!r.ok) return setErr("Could not build the report.");
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); const cd = r.headers.get("Content-Disposition") || ""; a.download = (cd.match(/filename="([^"]+)"/) || [])[1] || "output.xlsx"; a.click();
  }

  const list = useMemo(() => (read ? read.rows.map((r) => ({ row: r, v: res[key(r)] })) : []), [read, res]);
  const label = (x: Result) => x.final || x.status;
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of Object.values(res)) c[label(x)] = (c[label(x)] || 0) + 1;
    return c;
  }, [res]);
  const shown = list.filter((x) => filter === "All" || (x.v && label(x.v) === filter));
  const canFix = !!st?.writesAllowed;
  const needFix = counts["Needs fix"] || 0;

  const renderTable = (items: { row: Row; v?: Result }[]) => (
              <table>
                <thead><tr><th>Order</th><th>Type</th><th>Status</th><th className="num">File amount</th><th className="num">QBO total</th><th className="num">File tax</th><th className="num">QBO tax</th><th className="num">TaxDiff</th><th>What will change</th><th /></tr></thead>
                <tbody>
                  {items.map(({ row, v }) => v ? (
                    <Fragment2 key={key(row)} open={open === key(row)} onToggle={() => setOpen(open === key(row) ? null : key(row))}
                      cells={<>
                        <td><b>{v.order}</b></td><td>{v.type === "sale" ? "Sale" : "Refund"}</td>
                        <td><span className={"chip " + chipClass(label(v))}>{label(v)}</span>{v.inDeposit && <span className="chip dep">In deposit</span>}{}</td>
                        <td className="num">{money(v.settle)}</td><td className="num">{v.qboTotal ? money(v.qboTotal) : "-"}</td>
                        <td className="num">{money(v.fileTax)}</td><td className="num">{money(v.qboTax)}</td>
                        <td className="num">{v.status === "Not found" ? "–" : v.after ? money(v.after.taxDiff) : money(v.taxDiff)}</td>
                        <td className="small">{summary(v)}</td>
                        <td className="nowrap">
                          {v.status === "Needs fix" && !v.final && <><button className="btn small" disabled={!canFix} onClick={(e) => { e.stopPropagation(); fixOne(row); }}>Fix</button> <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); skipOne(row, true); }}>Skip</button></>}
                          {v.final === "Skipped" && <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); skipOne(row, false); }}>Undo skip</button>}
                          {v.final === "Tax to enter by hand" && <button className="btn small" onClick={(e) => { e.stopPropagation(); recheckOne(row); }}>Check again</button>}
                          {v.link && v.status !== "Matched" && v.status !== "Not found" && <> <a className="small" href={v.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open in QuickBooks</a></>}
                        </td>
                      </>}
                      detail={<div>
                        {v.error && <div className="alert">{v.error}</div>}
                        {v.message && <p className="small">{v.message}</p>}
                        {v.reason && <p className="small"><b>Reason:</b> {v.reason}</p>}
                        {v.blockers.length > 0 && <><b>Needs a person because</b><ul>{v.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></>}
                        {v.issues.length > 0 && <><b>Differences</b><ul>{v.issues.map((i, n) => <li key={n}>{i.field}: File {i.file}, QuickBooks {i.qbo}. {i.note}{i.auto ? "" : " (manual)"}</li>)}</ul></>}
                        {v.after && <p className="small">After saving: QuickBooks total {money(v.after.qboTotal)}, tax {money(v.after.qboTax)}, TaxDiff {money(v.after.taxDiff)}.</p>}
                      </div>} />
                  ) : null)}
                </tbody>
              </table>
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
        <h2><b>1</b> Upload the settlement file</h2>
        <label className={"drop" + (busy ? " busy" : "")}>
          {busy || <>Drop the settlement file here (Authorize.net download or the AuthorizeNet_…_output workbook) or <u>choose a file</u></>}
          <input type="file" hidden accept=".xlsx,.xls,.csv" disabled={!!busy || !st?.connected} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        {!st?.connected && <p className="small muted">Connect to QuickBooks first.</p>}
        {read && (
          <>
            <div className="tiles" style={{ marginTop: 14 }}>
              <div><span>To check</span><strong>{read.rows.length}</strong></div>
              <div><span>Sales receipts</span><strong>{read.rows.filter((r) => r.type === "sale").length}</strong></div>
              <div><span>Refunds</span><strong>{read.rows.filter((r) => r.type === "refund").length}</strong></div>
              <div><span>Skipped</span><strong>{read.skipped.length}</strong></div>
            </div>
            <p className="small muted">Skipped rows are not settled sales or credits: {Object.entries(read.counts).filter(([k]) => k !== "Settled Successfully" && k !== "Credited").map(([k, v]) => `${v} ${k}`).join(", ") || "none"}.</p>
            {read.problems.map((p, i) => <div key={i} className="note">{p}</div>)}
            {read.missingInQbo.length > 0 && <div className="alert">{read.missingInQbo.length} order(s) are not in QuickBooks. <button className="link" onClick={() => setPopup(true)}>See the list</button></div>}
          </>
        )}
      </section>

      <Find connected={!!st?.connected} company={st?.companyName || ""} sample={read?.rows[0]?.order} />

      {read && read.rows.length > 0 && (
        <section className="card">
          <h2><b>2</b> Check against QuickBooks <span className="muted small">(nothing is changed)</span></h2>
          <div className="row-actions">
            <button className="btn small" disabled={!!progress} onClick={runChecks}>{Object.keys(res).length ? "Run the check again" : "Run the check"}</button>
            {progress && <button className="btn small ghost" onClick={() => (cancel.current = true)}>Stop</button>}
            <button className="btn small ghost" disabled={!Object.keys(res).length} onClick={report}>Download output file (Excel)</button>
            <button className="btn small ghost" disabled={!Object.keys(res).length} onClick={needsPerson}>Download list for a person (CSV)</button>
          </div>
          {progress && <><div className="bar"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div><p className="small muted">{progress.label}: {progress.done} of {progress.total}</p></>}
          {Object.keys(res).length > 0 && (
            <>
              <div className="filters">
                {["All", ...Object.keys(counts)].map((f) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}{f !== "All" ? ` (${counts[f]})` : ""}</button>)}
              </div>
              {(["tax", "other", "rest"] as const).map((sec) => {
                const items = shown.filter((x) => x.v && sectionOf(x.v) === sec);
                if (!items.length) return null;
                const head = sec === "tax" ? ["Tax differences", "Only the tax is different. The fix changes the QuickBooks tax to the file's tax (and the total follows)."]
                  : sec === "other" ? ["Amount differs (not only tax)", "The difference is more than tax, so nothing is changed automatically. Review these by hand."]
                  : ["Matched, needs review, or not found", "No automatic fix for these."];
                return (<div key={sec} className="sect"><h3>{head[0]} <span className="muted small">({items.length})</span></h3><p className="small muted">{head[1]}</p>{renderTable(items)}</div>);
              })}
            </>
          )}
        </section>
      )}

      {needFix > 0 && (
        <section className="card">
          <h2><b>3</b> Apply the fixes</h2>
          <p className="small">{needFix} receipt(s) have a planned fix. Each is re-checked, saved, re-read from QuickBooks and compared with the file again. If it does not match, the receipt is put back. Rows that need a person are never changed.</p>
          <button className="btn" disabled={!canFix || !!progress} onClick={fixAll}>Fix all {needFix} that are ready</button>
          {!canFix && <p className="small muted">Changes are switched off for this QuickBooks company.</p>}
        </section>
      )}


      {popup && read && (
        <div className="modal-bg" onClick={() => setPopup(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Not found in QuickBooks</h2>
            <p className="small">These {read.missingInQbo.length} order(s) from the file are not in QuickBooks. They will not be created. The other rows can still be checked.</p>
            <ul>{read.missingInQbo.map((m) => <li key={m.docNumber}>{m.docNumber} <span className="muted">({m.type})</span></li>)}</ul>
            <button className="btn" onClick={() => setPopup(false)}>OK, continue</button>
          </div>
        </div>
      )}
    </main>
  );
}

function sectionOf(v: Result): "tax" | "other" | "rest" {
  const tax = v.issues.some((i) => i.field === "Tax"), other = v.issues.some((i) => i.field !== "Tax");
  if (v.status === "Matched" || v.status === "Not found") return "rest";
  if (other) return "other";
  return tax ? "tax" : "rest";
}
function summary(v: Result) {
  if (v.final === "Corrected, verified") return "Saved and verified";
  if (v.final === "Tax to enter by hand") return `Enter tax ${money(v.taxToEnter || 0)} by hand in QuickBooks (see the math, edit tax manually, reason: Other, apply override), then check again`;
  if (v.status === "Pending review" || v.status === "Not found") return v.blockers[0] || v.error || "";
  if (!v.plan.tax) return "";
  const pv = v.plan.preview, d = pv ? pv.taxTo - pv.taxFrom : 0;
  const amt = pv ? ` Tax ${money(pv.taxFrom)} → ${money(pv.taxTo)} (${d >= 0 ? "+" : "−"}${money(Math.abs(d))}); total ${money(pv.totalFrom)} → ${money(pv.totalTo)}.` : "";
  if (v.plan.tax.mode === "remove") return "Remove tax (untick Taxable on every line)." + amt;
  return (v.plan.untaxShipping ? `Make ${v.plan.untaxShipping.name} non-taxable.` : "Override the tax amount.") + amt;
}

function Fragment2({ cells, detail, open, onToggle }: { cells: React.ReactNode; detail: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (<><tr onClick={onToggle} style={{ cursor: "pointer" }}>{cells}</tr>{open && <tr className="detail"><td colSpan={10}>{detail}</td></tr>}</>);
}

function Find({ connected, company, sample }: { connected: boolean; company: string; sample?: string }) {
  const [q, setQ] = useState(""), [out, setOut] = useState<{ type: string; docNumber: string; date: string; total: number; customer: string }[] | null>(null), [msg, setMsg] = useState(""), [busy, setBusy] = useState(false);
  async function go(text: string) {
    setBusy(true); setMsg(""); setOut(null);
    try { setOut((await post("/api/find", { q: text })).found); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  }
  if (!connected) return null;
  return (
    <section className="card">
      <h2>Find an order in <b>{company || "this company"}</b></h2>
      <p className="small muted">Type an order number to see how QuickBooks numbers it in the connected company. If nothing is found, this is probably not the company that holds the orders: disconnect and connect again, choosing another company on the Intuit screen.</p>
      <div className="row-actions">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={sample ? `e.g. ${sample}` : "e.g. 72878"} style={{ padding: 6 }} />
        <button className="btn small" disabled={busy || !q.trim()} onClick={() => go(q)}>Find</button>
        {sample && <button className="btn small ghost" disabled={busy} onClick={() => { setQ(sample); go(sample); }}>Try the first order in my file</button>}
      </div>
      {msg && <div className="alert">{msg}</div>}
      {out && (out.length === 0 ? <p className="small">Nothing with that number in {company}. Try another company.</p>
        : <ul>{out.map((f, i) => <li key={i} className="small"><b>{f.docNumber}</b> ({f.type}) {f.date} {money(f.total)} {f.customer}</li>)}</ul>)}
    </section>
  );
}
