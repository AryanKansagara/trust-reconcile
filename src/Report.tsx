import { useEffect, useMemo, useState } from 'react'
import { EX_LABEL } from './engine/recon.ts'
import { makeSnapshot } from './engine/snapshot.ts'
import { correctionsCsv } from './Project.tsx'
import { JURISDICTIONS, pickMonth, useProject, useRecons } from './projectData.ts'
import { uuid } from './store.ts'
import { download, fmtDate, fmtMonth, go, Link, money, ThemeToggle, toast } from './ui.tsx'

export default function Report({ id }: { id: string }) {
  const { loading, project, ds, update } = useProject(id)
  const recs = useRecons(ds, project?.config)
  const months = useMemo(() => [...recs.keys()], [recs])
  const month = pickMonth(recs)
  const r = month ? recs.get(month) : undefined
  const snap = project?.snapshots.find(s => s.month === month)
  const today = new Date().toISOString().slice(0, 10)
  const [who, setWho] = useState({ reconciler: '', reviewer: '' })
  useEffect(() => { if (project) setWho({ reconciler: snap?.signoff?.reconciler ?? project.firm.reconciler, reviewer: snap?.signoff?.reviewer ?? project.firm.reviewer }) }, [project?.id, snap?.id, snap?.signoff?.reconciler, snap?.signoff?.reviewer])
  useEffect(() => { if (project && month) document.title = `Three-way reconciliation ${fmtMonth(month)} · ${project.name}` }, [project?.name, month])

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Preparing the report</div>
  if (!project || !r || !month || !ds) return (
    <div className="page narrow center notfound"><h1>Nothing to report yet</h1><p className="muted">Import a bank statement and the trust journal first.</p><Link href={project ? `/app/p/${id}/data` : '/app'} className="btn primary">Go back</Link></div>
  )

  const sign = (role: 'reconciler' | 'reviewer') => {
    const name = who[role].trim()
    if (!name) { toast(`Type the ${role}'s name first`, { tone: 'error' }); return }
    const prev = project.snapshots
    const base = snap ?? makeSnapshot(r, uuid(), project.config.currency)
    const signoff = role === 'reconciler'
      ? { ...base.signoff, reconciler: name, reconciledAt: today }
      : { reconciler: base.signoff?.reconciler ?? '', reconciledAt: base.signoff?.reconciledAt ?? '', reviewer: name, reviewedAt: today }
    if (role === 'reviewer' && !base.signoff?.reconciler) { toast('The reconciler signs first', { tone: 'error' }); return }
    // Signing freezes the current numbers into the snapshot.
    const fresh = { ...makeSnapshot(r, base.id, project.config.currency), signoff }
    update({ snapshots: [...prev.filter(s => s.month !== month), fresh].sort((a, b) => a.month.localeCompare(b.month)), firm: { ...project.firm, [role]: name } })
    toast(`Signed as ${role}`, { tone: 'ok', undo: () => update({ snapshots: prev }) })
  }

  const before = ds.book.filter(e => e.date < r.start).reduce((a, e) => a + e.amount, 0)
  const inMonth = ds.book.filter(e => e.date >= r.start && e.date <= r.end)
  const receipts = inMonth.filter(e => e.amount > 0).reduce((a, e) => a + e.amount, 0)
  const payments = inMonth.filter(e => e.amount < 0).reduce((a, e) => a + e.amount, 0)
  const rule = JURISDICTIONS[project.config.jurisdiction]
  const so = snap?.signoff

  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <Link href={`/app/p/${id}?m=${month}`} className="btn ghost sm">&larr; {project.name}</Link>
        <label className="ctl inline"><span>Month</span><select value={month} onChange={e => go(`${location.pathname}?m=${e.target.value}`, { replace: true })}>{[...months].reverse().map(m => <option key={m} value={m}>{fmtMonth(m)}</option>)}</select></label>
        <span className="grow" />
        <label className="ctl inline"><span>Reconciler</span><input value={who.reconciler} onChange={e => setWho({ ...who, reconciler: e.target.value })} style={{ width: 170 }} placeholder="Name" /></label>
        <button type="button" className="btn ghost sm" onClick={() => sign('reconciler')}>{so?.reconciler ? 'Re-sign' : 'Sign'}</button>
        <label className="ctl inline"><span>Reviewer</span><input value={who.reviewer} onChange={e => setWho({ ...who, reviewer: e.target.value })} style={{ width: 170 }} placeholder="Licensee" /></label>
        <button type="button" className="btn ghost sm" onClick={() => sign('reviewer')}>{so?.reviewer ? 'Re-sign' : 'Review'}</button>
        <ThemeToggle />
        <button type="button" className="btn ghost sm" onClick={() => download(`correcting-entries-${month}.csv`, correctionsCsv(r))}>Entries CSV</button>
        <button type="button" className="btn primary sm" onClick={() => print()}>Print or save PDF</button>
      </div>

      <article className="sheet">
        <header className="sheet-head">
          <div>
            <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: '#5d5d5d' }}>Monthly three-way trust reconciliation</div>
            <h1>{project.firm.name || project.name}</h1>
            <div style={{ color: '#5d5d5d' }}>{project.firm.address}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 300 }}>{fmtMonth(month)}</div>
            <div style={{ color: '#5d5d5d' }}>Period {fmtDate(r.start)} to {fmtDate(r.end)}</div>
            {project.sampleId && <div style={{ color: '#b42318', fontWeight: 600 }}>SYNTHETIC SAMPLE</div>}
          </div>
        </header>
        <div className="sheet-meta">
          <div><span>Trust account</span>{project.config.accountName}</div>
          <div><span>Prepared</span>{fmtDate(today)}</div>
          <div><span>Rules</span>{rule.rule}</div>
        </div>

        <div className="tie3">
          <div><span>A · Adjusted bank balance</span><b>{money(r.adjustedBank)}</b></div>
          <div><span>B · Trust journal balance</span><b>{money(r.journal)}</b></div>
          <div><span>C · Total of client ledgers</span><b>{money(r.clientTotal)}</b></div>
        </div>
        <div className={`verdict ${r.tiesOut ? 'ok' : 'off'}`}>
          {r.tiesOut ? 'A = B = C. The trust account is reconciled for the period.' : `Not reconciled. A − B = ${money(r.adjustedBank - r.journal)}; B − C = ${money(r.journal - r.clientTotal)}. Differences are itemised in section D.`}
        </div>

        <h2>A · Bank reconciliation</h2>
        <table><tbody>
          <tr><th>Balance per bank statement at {fmtDate(r.end)}</th><td className="num">{money(r.statement.closing)}</td></tr>
          <tr><th>Add: deposits in transit</th><td /></tr>
          {r.outstandingDeposits.map(e => <tr key={e.id} className="ind"><th>{e.date} · {e.matter || 'No client'} · {e.desc}</th><td className="num">{money(e.amount)}</td></tr>)}
          {!r.outstandingDeposits.length && <tr className="ind"><th>None</th><td className="num">{money(0)}</td></tr>}
          <tr><th>Less: outstanding cheques and withdrawals</th><td /></tr>
          {r.outstandingCheques.map(e => <tr key={e.id} className="ind"><th>{e.date} · {e.ref ? `#${e.ref} · ` : ''}{e.payee || e.desc} ({e.matter || 'no client'})</th><td className="num">{money(e.amount)}</td></tr>)}
          {!r.outstandingCheques.length && <tr className="ind"><th>None</th><td className="num">{money(0)}</td></tr>}
          <tr className="sub"><th>Adjusted bank balance (A)</th><td className="num">{money(r.adjustedBank)}</td></tr>
        </tbody></table>
        {r.statement.source !== 'file' && r.statement.source !== 'manual' && <p style={{ color: '#a84300' }}>Statement balance {r.statement.source === 'derived' ? 'carried forward from the prior month plus this month’s lines' : 'assumed; not confirmed against a statement'}.</p>}

        <h2>B · Trust journal</h2>
        <table><tbody>
          <tr><th>Balance at {fmtDate(r.start)}</th><td className="num">{money(before)}</td></tr>
          <tr><th>Receipts ({inMonth.filter(e => e.amount > 0).length})</th><td className="num">{money(receipts)}</td></tr>
          <tr><th>Disbursements ({inMonth.filter(e => e.amount < 0).length})</th><td className="num">{money(payments)}</td></tr>
          <tr className="sub"><th>Journal balance at {fmtDate(r.end)} (B)</th><td className="num">{money(r.journal)}</td></tr>
        </tbody></table>

        <h2>C · Client ledger balances</h2>
        <table>
          <thead><tr><th>Matter</th><th>Client</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {r.clients.map(c => <tr key={c.matter}><td className="mono">{c.matter}</td><td>{c.client}</td><td className="num" style={{ color: c.balance < 0 ? '#b42318' : undefined }}>{money(c.balance)}</td></tr>)}
            <tr className="sub"><th colSpan={2}>Total of client ledgers (C) · {r.clientSource === 'imported' ? 'per client balances report' : 'derived from journal'}</th><td className="num">{money(r.clientTotal)}</td></tr>
          </tbody>
        </table>

        <h2>D · Differences and explanations</h2>
        {r.tiesOut ? <p>None. A, B and C agree.</p> : (
          <table><tbody>
            {r.bankOnly.map(b => <tr key={b.id}><th>On statement, not in journal: {b.date} {b.desc}</th><td className="num">{money(b.amount)}</td></tr>)}
            {r.unallocated.filter(e => e.date >= r.start).map(e => <tr key={e.id}><th>In journal with no client ledger: {e.date} {e.desc}</th><td className="num">{money(e.amount)}</td></tr>)}
            {r.unallocated.some(e => e.date < r.start) && <tr><th>In journal with no client ledger, earlier months</th><td className="num">{money(r.unallocated.filter(e => e.date < r.start).reduce((a, e) => a + e.amount, 0))}</td></tr>}
            {r.clients.filter(c => c.imported !== undefined && c.imported !== c.derived).map(c => <tr key={c.matter}><th>Client report differs from journal: {c.matter}</th><td className="num">{money(c.derived - c.balance)}</td></tr>)}
            {(r.unexplainedBank !== 0 || r.unexplainedClients !== 0) && <tr className="sub"><th>Unexplained</th><td className="num">{money(r.unexplainedBank + r.unexplainedClients)}</td></tr>}
          </tbody></table>
        )}

        <h2>E · Findings requiring action</h2>
        {r.exceptions.length ? (
          <table>
            <thead><tr><th>Severity</th><th>Finding</th><th className="num">Amount</th></tr></thead>
            <tbody>{r.exceptions.map(e => <tr key={e.id}><td style={{ textTransform: 'capitalize' }}>{e.severity}</td><td><b>{EX_LABEL[e.kind]}</b> · {e.title}</td><td className="num">{money(e.amount)}</td></tr>)}</tbody>
          </table>
        ) : <p>None.</p>}

        <div className="signoff">
          <div>
            <div className="sig-line">{so?.reconciler ?? ''}</div>
            <div className="sig-label"><span>Prepared by (reconciler){so?.reconciler ? `: ${so.reconciler}` : ''}</span><span>Date {so?.reconciledAt ?? '__________'}</span></div>
          </div>
          <div>
            <div className="sig-line">{so?.reviewer ?? ''}</div>
            <div className="sig-label"><span>Reviewed by (responsible lawyer){so?.reviewer ? `: ${so.reviewer}` : ''}</span><span>Date {so?.reviewedAt ?? '__________'}</span></div>
          </div>
        </div>
        <p className="sheet-foot">
          Prepared with Trust Reconcile from the bank statement, trust journal and client ledger exports for the period, processed on the preparer’s device. Keep this report with the trust records for the retention period your rules require. {project.config.jurisdiction === 'on' ? 'By-Law 9 expects the monthly comparison within 25 days of the statement period end.' : project.config.jurisdiction === 'bc' ? 'Rule 3-73 expects the reconciliation within 30 days of its effective date.' : ''} This is a working paper, not legal or accounting advice.
        </p>
      </article>
    </div>
  )
}
