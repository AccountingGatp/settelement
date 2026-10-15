"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseSettlement } from "@/lib/settlement";

type Issue = { field: string; woo: string; qbo: string; diff: number; note: string; auto: boolean };
type Verdict = {
  order: string; type: "sale" | "refund"; customer: string; status: "Matched" | "Needs fix" | "Pending review" | "Not found"; scenario: string;
  settle: number; wooTotal: number; wooTax: number; qboTotal: number; qboTax: number; taxDiff: number; totalDiff: number; inDeposit: boolean;
  issues: Issue[]; plan: { tax?: { mode: string; total?: number }; addLines: { itemName: string; amount: number }[]; replaceLines?: { itemName: string; amount: number; discount?: boolean }[] }; blockers: string[]; notes: string[];
};
type Row = { order: string; type: "sale" | "refund"; amount: number; fileTax: number; fileFreight: number; txnId: string; customer: string };
type Result = Verdict & { final?: string; after?: Verdict; error?: string; message?: string };
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
    setProgress({ done, total: read.rows.length, label: "Checking against Woo and QuickBooks" });
    await pool(read.rows, 3, async (row) => {
      try {
        const v = (await post("/api/check", { row })) as Verdict;
        setRes((p) => ({ ...p, [key(row)]: v }));
      } catch (e) {
        setRes((p) => ({ ...p, [key(row)]: { ...(blankFor(row)), error: e instanceof Error ? e.message : String(e) } }));
      }
      setProgress({ done: ++done, total: read.rows.length, label: "Checking against Woo and QuickBooks" });
    }, () => cancel.current);
    setProgress(null);
  }

  function blankFor(row: Row): Result {
    return { order: row.order, type: row.type, customer: row.customer, status: "Pending review", scenario: "-", settle: row.amount, wooTotal: 0, wooTax: 0, qboTotal: 0, qboTax: 0, taxDiff: 0, totalDiff: 0, inDeposit: false, issues: [], plan: { addLines: [] }, blockers: [], notes: [] };
  }

  async function fixOne(row: Row) {
    const k = key(row);
    try {
      const j = await post("/api/fix", { row });
      setRes((p) => ({ ...p, [k]: { ...j.after, plan: j.before.plan, issues: j.applied ? j.before.issues : j.after.issues, blockers: j.after.blockers, final: j.applied ? (j.verified ? "Corrected, verified" : "Failed") : undefined, after: j.applied ? j.after : undefined, message: j.message, taxDiff: j.applied ? j.before.taxDiff : j.after.taxDiff, qboTax: j.before.qboTax, qboTotal: j.before.qboTotal } }));
    } catch (e) {
      setRes((p) => ({ ...p, [k]: { ...p[k], final: "Failed", error: e instanceof Error ? e.message : String(e) } }));
    }
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
    await pool(todo, 1, async (row) => { await fixOne(row); setProgress({ done: ++done, total: todo.length, label: "Fixing" }); }, () => cancel.current);
    setProgress(null);
  }

  async function report() {
    const r = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ results: Object.values(res) }) });
    if (!r.ok) return setErr("Could not build the report.");
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = "reconciliation-report.xlsx"; a.click();
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
          {busy || <>Drop the Authorize.net settlement download here or <u>choose a file</u></>}
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

      {read && read.rows.length > 0 && (
        <section className="card">
          <h2><b>2</b> Check against Woo and QuickBooks <span className="muted small">(nothing is changed)</span></h2>
          <div className="row-actions">
            <button className="btn small" disabled={!!progress} onClick={runChecks}>{Object.keys(res).length ? "Run the check again" : "Run the check"}</button>
            {progress && <button className="btn small ghost" onClick={() => (cancel.current = true)}>Stop</button>}
            <button className="btn small ghost" disabled={!Object.keys(res).length} onClick={report}>Download report (Excel)</button>
          </div>
          {progress && <><div className="bar"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div><p className="small muted">{progress.label}: {progress.done} of {progress.total}</p></>}
          {Object.keys(res).length > 0 && (
            <>
              <div className="filters">
                {["All", ...Object.keys(counts)].map((f) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}{f !== "All" ? ` (${counts[f]})` : ""}</button>)}
              </div>
              <table>
                <thead><tr><th>Order</th><th>Type</th><th>Status</th><th className="num">Settlement</th><th className="num">QBO total</th><th className="num">Woo tax</th><th className="num">QBO tax</th><th className="num">TaxDiff</th><th>What will change</th><th /></tr></thead>
                <tbody>
                  {shown.map(({ row, v }) => v ? (
                    <Fragment2 key={key(row)} open={open === key(row)} onToggle={() => setOpen(open === key(row) ? null : key(row))}
                      cells={<>
                        <td><b>{v.order}</b></td><td>{v.type === "sale" ? "Sale" : "Refund"}</td>
                        <td><span className={"chip " + chipClass(label(v))}>{label(v)}</span>{v.inDeposit && <span className="chip dep">In deposit</span>}</td>
                        <td className="num">{money(v.settle)}</td><td className="num">{v.qboTotal ? money(v.qboTotal) : "-"}</td>
                        <td className="num">{money(v.wooTax)}</td><td className="num">{money(v.qboTax)}</td>
                        <td className="num">{v.status === "Not found" ? "–" : v.after ? money(v.after.taxDiff) : money(v.taxDiff)}</td>
                        <td className="small">{summary(v)}</td>
                        <td className="nowrap">
                          {v.status === "Needs fix" && !v.final && <><button className="btn small" disabled={!canFix} onClick={(e) => { e.stopPropagation(); fixOne(row); }}>Fix</button> <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); skipOne(row, true); }}>Skip</button></>}
                          {v.final === "Skipped" && <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); skipOne(row, false); }}>Undo skip</button>}
                        </td>
                      </>}
                      detail={<div>
                        {v.error && <div className="alert">{v.error}</div>}
                        {v.message && <p className="small">{v.message}</p>}
                        {v.blockers.length > 0 && <><b>Needs a person because</b><ul>{v.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></>}
                        {v.issues.length > 0 && <><b>Differences</b><ul>{v.issues.map((i, n) => <li key={n}>{i.field}: Woo {i.woo}, QuickBooks {i.qbo}. {i.note}{i.auto ? "" : " (manual)"}</li>)}</ul></>}
                        {v.after && <p className="small">After saving: QuickBooks total {money(v.after.qboTotal)}, tax {money(v.after.qboTax)}, TaxDiff {money(v.after.taxDiff)}.</p>}
                      </div>} />
                  ) : null)}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {needFix > 0 && (
        <section className="card">
          <h2><b>3</b> Apply the fixes</h2>
          <p className="small">{needFix} receipt(s) have a planned fix. Each is re-checked, saved, re-read from QuickBooks and compared with Woo again. Rows that need a person are never changed.</p>
          <button className="btn" disabled={!canFix || !!progress} onClick={fixAll}>Fix all {needFix} that are ready</button>
          {!canFix && <p className="small muted">Changes are switched off for this QuickBooks company.</p>}
        </section>
      )}

      {st?.connected && st.environment === "sandbox" && <Seed />}

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

function summary(v: Result) {
  if (v.final === "Corrected, verified") return "Saved and verified";
  const p: string[] = [];
  if (v.plan.tax) p.push(v.plan.tax.mode === "remove" ? "Remove tax" : `Set tax to ${money(v.plan.tax.total || 0)}`);
  v.plan.addLines.forEach((a) => p.push(`Add ${a.itemName} ${money(a.amount)}`));
  if (v.plan.replaceLines) p.push(`Rebuild lines from Woo (${v.plan.replaceLines.length})`);
  if (v.status === "Pending review" || v.status === "Not found") return v.blockers[0] || v.error || "";
  return p.join("; ");
}

function Fragment2({ cells, detail, open, onToggle }: { cells: React.ReactNode; detail: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (<><tr onClick={onToggle} style={{ cursor: "pointer" }}>{cells}</tr>{open && <tr className="detail"><td colSpan={10}>{detail}</td></tr>}</>);
}

function Seed() {
  const [day, setDay] = useState("0909");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true); setLog([]);
    try {
      const l = await (await fetch(`/api/seed?day=${day}`)).json();
      let ok = 0, same = 0;
      for (const order of l.orders as string[]) {
        try {
          const j = await post("/api/seed", { day, order });
          if (j.skipped) setLog((p) => [...p, `${order}: already there`]);
          else { ok++; if (j.matchesOld) same++; setLog((p) => [...p, `${order}: created, total ${j.got.total} tax ${j.got.tax} (wanted ${j.wanted.total} / ${j.wanted.tax})${j.omitted ? `, left out ${j.omitted}` : ""}${j.matchesOld ? "" : "  ← does not match the old receipt"}`]); }
        } catch (e) { setLog((p) => [...p, `${order}: ${e instanceof Error ? e.message : e}`]); }
      }
      setLog((p) => [...p, `Done: ${ok} created, ${same} match the old receipts exactly.`]);
    } finally { setBusy(false); }
  }
  return (
    <section className="card sandbox">
      <h2>Sandbox only: create test receipts</h2>
      <p className="small">Creates receipts in the QuickBooks <b>sandbox</b> for real Woo orders, with the same wrong totals and tax the old books had, so the check and fixes can be tried safely.</p>
      <select value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 200 }}><option value="0909">9 Sep (49 sales)</option><option value="0908">8 Sep (61 sales)</option></select>{" "}
      <button className="btn small" disabled={busy} onClick={run}>{busy ? "Creating…" : "Create test receipts"}</button>
      {log.length > 0 && <pre className="small" style={{ maxHeight: 220, overflow: "auto", background: "#f7f8fa", padding: 10, borderRadius: 8 }}>{log.join("\n")}</pre>}
    </section>
  );
}
