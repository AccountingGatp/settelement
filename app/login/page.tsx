"use client";
import { useState } from "react";
export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  async function go(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    const j = await r.json().catch(() => ({ error: `Server error ${r.status}. Check the settings in Vercel and Redeploy.` }));
    if (r.ok) location.href = "/"; else setErr(j.error || "Login failed");
  }
  return (
    <main className="narrow">
      <form className="card" onSubmit={go}>
        <h1>Settlement Reconciliation</h1>
        <p className="muted">Enter the team password.</p>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" autoFocus />
        {err && <div className="alert">{err}</div>}
        <button className="btn" type="submit">Log in</button>
      </form>
    </main>
  );
}
