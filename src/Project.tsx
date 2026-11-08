import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { correctionRows, type MonthRecon } from './engine/recon.ts'
import { toCsv } from './engine/importer.ts'
import { makeSnapshot } from './engine/snapshot.ts'
import type { Config, Dataset } from './engine/types.ts'
import { JURISDICTIONS, pickMonth, useProject, useRecons } from './projectData.ts'
import { uuid, type Project } from './store.ts'
import { download, fmtDate, fmtMonth, go, isTyping, Link, Modal, money, plural, SyntheticBadge, toast } from './ui.tsx'

const Panels = lazy(() => import('./Panels.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [['tieout', 'Tie-out'], ['matching', 'Matching'], ['exceptions', 'Exceptions'], ['letters', 'Letters'], ['history', 'History'], ['data', 'Data']] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps {
  project: Project
  ds: Dataset
  r: MonthRecon
  recs: Map<string, MonthRecon>
  month: string
  months: string[]
  setConfig(p: Partial<Config>): void
  update(p: Partial<Project>): void
  onTab(t: Tab): void
}

export const correctionsCsv = (r: MonthRecon) => toCsv(correctionRows(r))

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, ds, setConfig, update, reload } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'tieout') as Tab
  const recs = useRecons(ds, project?.config)
  const months = useMemo(() => [...recs.keys()], [recs])
  const month = pickMonth(recs)
  const r = month ? recs.get(month)! : null
  const [help, setHelp] = useState(false)

  useEffect(() => { if (project) document.title = `${project.name}${month ? ` · ${fmtMonth(month)}` : ''} · Trust Reconcile` }, [project?.name, month])

  const q = (m: string | null) => m ? `?m=${m}` : ''
  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'tieout' ? '' : '/' + t}${q(month)}`, { keepScroll: true })
  const setMonth = (m: string) => go(`${location.pathname}?m=${m}`, { replace: true, keepScroll: true })

  const closeMonth = () => {
    if (!project || !r || !month) return
    const prev = project.snapshots.find(s => s.month === month)
    const snap = makeSnapshot(r, prev?.id ?? uuid(), project.config.currency, prev?.signoff)
    const snapshots = [...project.snapshots.filter(s => s.month !== month), snap].sort((a, b) => a.month.localeCompare(b.month))
    void update({ snapshots })
    toast(prev ? `Updated the ${fmtMonth(month)} snapshot${prev.signoff ? ' (sign-off kept)' : ''}` : `Closed ${fmtMonth(month)}. Sign it on the report.`, { tone: 'ok', undo: () => void update({ snapshots: project.snapshots }) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1][0]) }
      else if (e.key === '?') setHelp(true)
      else if (e.key === 's' && r) closeMonth()
      else if (e.key === 'p' && month) go(`/app/p/${id}/report?m=${month}`)
      else if (e.key === '[' || e.key === ']') {
        const i = months.indexOf(month ?? '')
        const j = e.key === '[' ? i - 1 : i + 1
        if (months[j]) setMonth(months[j])
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Reconciling</div>
  if (!project) return (
    <section className="page narrow center notfound">
      <h1>Trust account not found</h1>
      <p className="muted">It may have been deleted, or it lives on another device and has not synced yet.</p>
      <Link href="/app" className="btn primary">Back to trust accounts</Link>
    </section>
  )

  const noData = !r
  const effectiveTab: Tab = noData ? 'data' : tab
  const snap = month ? project.snapshots.find(s => s.month === month) : undefined

  return (
    <section className="page project">
      <div className="project-head">
        <div className="crumbs"><Link href="/app">Trust accounts</Link><span aria-hidden="true">/</span><span>{JURISDICTIONS[project.config.jurisdiction].short}</span></div>
        <div className="row between wrap gap">
          <div className="row gap-sm wrap">
            <h1 className="project-title">{project.name}</h1>
            {project.sampleId && <SyntheticBadge />}
          </div>
          {r && month && (
            <div className="row gap-sm wrap">
              <Link href={`/app/p/${id}/report?m=${month}`} className="btn primary sm" title="Shortcut: P">Report &amp; sign-off</Link>
              <button type="button" className="btn ghost sm" onClick={() => download(`correcting-entries-${month}.csv`, correctionsCsv(r))}>Correcting entries CSV</button>
              <button type="button" className="btn ghost sm" onClick={closeMonth} title="Shortcut: S">{snap ? 'Update snapshot' : 'Close month'}</button>
            </div>
          )}
        </div>
        {r && month && (
          <div className="controls">
            <label className="ctl"><span>Statement month</span>
              <select value={month} onChange={e => setMonth(e.target.value)}>{[...months].reverse().map(m => <option key={m} value={m}>{fmtMonth(m)}</option>)}</select>
            </label>
            <div className="ctl"><span>Status</span>
              <div className="row gap-sm" style={{ minHeight: 40 }}>
                {r.tiesOut ? <span className="chip good">Ties out</span> : <span className="chip critical">Does not tie out</span>}
                {snap?.signoff?.reviewer ? <span className="chip good">Signed and reviewed</span> : snap?.signoff ? <span className="chip warn">Signed, not reviewed</span> : snap ? <span className="chip warn">Closed, not signed</span> : <span className="chip neutral">Open</span>}
              </div>
            </div>
          </div>
        )}
        <nav className="tabs" aria-label="Reconciliation sections">
          {TABS.map(([t, label], i) => (
            <Link key={t} href={`/app/p/${id}${t === 'tieout' ? '' : '/' + t}${q(month)}`} aria-current={effectiveTab === t ? 'page' : undefined} className={noData && t !== 'data' ? 'disabled' : ''} title={`Shortcut: ${i + 1}`}>
              {label}
              {t === 'exceptions' && r && r.exceptions.length > 0 && <span className={`count${r.exceptions.some(e => e.severity === 'critical') ? ' bad' : ''}`}>{r.exceptions.length}</span>}
              {t === 'matching' && r && <span className="count">{r.outstandingCheques.length + r.outstandingDeposits.length + r.bankOnly.length}</span>}
              {t === 'letters' && r && r.exceptions.some(e => e.kind === 'stale') && <span className="count">{r.exceptions.filter(e => e.kind === 'stale').length}</span>}
              {t === 'history' && project.snapshots.length > 0 && <span className="count">{project.snapshots.length}</span>}
            </Link>
          ))}
          <button type="button" className="linkish small kbd-help hide-sm" onClick={() => setHelp(true)}>Shortcuts <kbd>?</kbd></button>
        </nav>
      </div>

      <Suspense fallback={<div className="boot" role="status"><span className="spinner" /> Loading</div>}>
        {effectiveTab === 'data' || !r || !month || !ds
          ? <DataTab project={project} ds={ds} update={update} setConfig={setConfig} reload={reload} recs={recs} />
          : effectiveTab === 'tieout'
            ? <TieOut project={project} ds={ds} r={r} recs={recs} month={month} months={months} setConfig={setConfig} update={update} onTab={setTab} />
            : <Panels tab={effectiveTab} project={project} ds={ds} r={r} recs={recs} month={month} months={months} setConfig={setConfig} update={update} onTab={setTab} />}
      </Suspense>

      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>6</kbd></dt><dd>Switch tabs</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next statement month</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Close the month (save a snapshot)</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Open the printable report</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last change</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>This list</dd></div>
        </dl>
      </Modal>
    </section>
  )
}

// ---------- Tie-out ----------

function TieOut({ project, ds, r, month, setConfig, onTab }: TabProps) {
  const critical = r.exceptions.filter(e => e.severity === 'critical')
  const before = ds.book.filter(e => e.date < r.start).reduce((a, e) => a + e.amount, 0)
  const inMonth = ds.book.filter(e => e.date >= r.start && e.date <= r.end)
  const receipts = inMonth.filter(e => e.amount > 0).reduce((a, e) => a + e.amount, 0)
  const payments = inMonth.filter(e => e.amount < 0).reduce((a, e) => a + e.amount, 0)
  const pos = r.clients.filter(c => c.balance > 0).reduce((a, c) => a + c.balance, 0)
  const negs = r.clients.filter(c => c.balance < 0)
  const bankVsBook = r.adjustedBank - r.journal
  const bookVsCli = r.journal - r.clientTotal
  const kindsBank = groupBankOnly(r)
  const matchedPct = r.bankLines.length ? Math.round(100 * r.bankLines.filter(b => r.matches.some(m => m.bank.includes(b.id))).length / r.bankLines.length) : 0
  const stmt = project.config.statements[month]
  const sourceLabel = { file: 'from the statement file', manual: 'entered by you', derived: 'carried from last month plus this month’s lines', assumed: 'assumed: no statement balance yet' }[r.statement.source]

  return (
    <div className="tab-body">
      <div className={`status-hero ${r.tiesOut ? 'ok' : 'off'}`}>
        <div className="mark" aria-hidden="true">{r.tiesOut ? '✓' : '!'}</div>
        <div className="grow">
          <h2>{r.tiesOut ? `${fmtMonth(month)} ties out to the cent` : `${fmtMonth(month)} does not tie out`}</h2>
          <p>{r.tiesOut
            ? `Adjusted bank, trust journal and client ledgers all equal ${money(r.journal)}.${r.dit || r.oc ? ` Reconciling items: ${plural(r.outstandingDeposits.length, 'deposit')} in transit, ${plural(r.outstandingCheques.length, 'outstanding cheque')}.` : ''}`
            : r.unexplainedBank || r.unexplainedClients
              ? `${money(r.unexplainedBank + r.unexplainedClients)} of the difference has no identified cause. Start with the critical findings.`
              : `Every cent of difference is explained below by ${plural(r.bankOnly.length + r.unallocated.length + r.clients.filter(c => c.imported !== undefined && c.imported !== c.derived).length, 'item')}. Fix them and re-import, or record the correcting entries.`}</p>
        </div>
        {critical.length > 0 && <button type="button" className="btn danger sm" onClick={() => onTab('exceptions')}>{plural(critical.length, 'critical finding')}</button>}
      </div>

      <div className="board">
        <div className="board-col" style={{ ['--c' as string]: 'var(--col-bank)' }}>
          <h3>1 · Bank</h3>
          <div className="board-total">{money(r.adjustedBank)}</div>
          <div className="bridge">
            <div><span>Statement closing balance</span><b className="num">{money(r.statement.closing)}</b></div>
            <div><span>+ Deposits in transit ({r.outstandingDeposits.length})</span><span className="num">{money(r.dit)}</span></div>
            <div><span>− Outstanding cheques ({r.outstandingCheques.length})</span><span className="num">{money(r.oc)}</span></div>
            <div className="total"><span>Adjusted bank balance</span><span className="num">{money(r.adjustedBank)}</span></div>
          </div>
        </div>
        <div className="board-col" style={{ ['--c' as string]: 'var(--col-book)' }}>
          <h3>2 · Trust journal</h3>
          <div className="board-total">{money(r.journal)}</div>
          <div className="bridge">
            <div><span>Balance at {fmtDate(r.start)}</span><span className="num">{money(before)}</span></div>
            <div><span>+ Receipts ({inMonth.filter(e => e.amount > 0).length})</span><span className="num">{money(receipts)}</span></div>
            <div><span>− Disbursements ({inMonth.filter(e => e.amount < 0).length})</span><span className="num">{money(payments)}</span></div>
            <div className="total"><span>Journal at {fmtDate(r.end)}</span><span className="num">{money(r.journal)}</span></div>
          </div>
        </div>
        <div className="board-col" style={{ ['--c' as string]: 'var(--col-client)' }}>
          <h3>3 · Client ledgers</h3>
          <div className="board-total">{money(r.clientTotal)}</div>
          <div className="bridge">
            <div><span>{r.clientSource === 'imported' ? 'From the client balances report' : 'Derived from the journal per matter'}</span><span className="num">{plural(r.clients.length, 'matter')}</span></div>
            <div><span>Clients in credit</span><span className="num">{money(pos)}</span></div>
            <div><span>Clients overdrawn ({negs.length})</span><span className={`num${negs.length ? ' neg' : ''}`}>{money(negs.reduce((a, c) => a + c.balance, 0))}</span></div>
            <div className="total"><span>Total client ledgers</span><span className="num">{money(r.clientTotal)}</span></div>
          </div>
        </div>
        <div className="board-diff">
          <div>
            <h4><span>Bank − journal</span><span className={bankVsBook ? 'neg' : 'pos'}>{money(bankVsBook, { sign: true })}</span></h4>
            <ul className="explain-list">
              {kindsBank.map(k => <li key={k.label}><span>{k.label} ({k.n})</span><span className="num">{money(k.amount, { sign: true })}</span></li>)}
              {!kindsBank.length && !r.unexplainedBank && <li><span className="muted">Nothing to explain</span><span /></li>}
              {r.unexplainedBank !== 0 && <li className="rem neg"><span>Unexplained</span><span className="num">{money(r.unexplainedBank, { sign: true })}</span></li>}
            </ul>
          </div>
          <div>
            <h4><span>Journal − client ledgers</span><span className={bookVsCli ? 'neg' : 'pos'}>{money(bookVsCli, { sign: true })}</span></h4>
            <ul className="explain-list">
              {r.unallocated.length > 0 && <li><span>Journal entries with no client ({r.unallocated.length})</span><span className="num">{money(r.unallocatedTotal, { sign: true })}</span></li>}
              {r.ledgerDiffTotal !== 0 && <li><span>Client report differs from journal</span><span className="num">{money(r.ledgerDiffTotal, { sign: true })}</span></li>}
              {!r.unallocated.length && !r.ledgerDiffTotal && !r.unexplainedClients && <li><span className="muted">Nothing to explain</span><span /></li>}
              {r.unexplainedClients !== 0 && <li className="rem neg"><span>Unexplained</span><span className="num">{money(r.unexplainedClients, { sign: true })}</span></li>}
            </ul>
          </div>
        </div>
      </div>

      <div className="kpis">
        <button type="button" className="kpi" onClick={() => onTab('matching')}><span>Bank lines matched</span><b>{matchedPct}%</b><small>{r.matches.length} matches, {r.matches.filter(m => m.how === 'batch').length} batched</small></button>
        <button type="button" className="kpi" onClick={() => onTab('matching')}><span>Carried to next month</span><b>{r.outstandingDeposits.length + r.outstandingCheques.length}</b><small>{money(r.dit + r.oc)} net outstanding</small></button>
        <button type="button" className={`kpi ${critical.length ? 'bad' : 'good'}`} onClick={() => onTab('exceptions')}><span>Critical findings</span><b>{critical.length}</b><small>{plural(r.exceptions.length - critical.length, 'other finding')}</small></button>
        <button type="button" className="kpi" onClick={() => onTab('history')}><span>Months signed</span><b>{project.snapshots.filter(s => s.signoff).length}</b><small>of {project.snapshots.length} closed</small></button>
      </div>

      {r.assumedCleared.length > 0 && (
        <div className="fix-banner warn"><div><strong>{plural(r.assumedCleared.length, 'journal entry', 'journal entries')} before your first statement were assumed cleared.</strong><p className="small">They matched nothing on the {fmtMonth(month)} statement, so they are treated as cleared in an earlier month. Import the previous month’s statement to check them properly.</p></div></div>
      )}

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Statement balances</h2><span className="muted small">{sourceLabel}</span></div>
          <form className="stmt-form" onSubmit={e => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            const opening = Math.round(Number(f.get('opening')) * 100), closing = Math.round(Number(f.get('closing')) * 100)
            if (!Number.isFinite(opening) || !Number.isFinite(closing)) return
            const prev = project.config.statements
            setConfig({ statements: { ...prev, [month]: { opening, closing, source: 'manual' } } })
            toast('Statement balances saved', { tone: 'ok', undo: () => setConfig({ statements: prev }) })
          }}>
            <label className="ctl"><span>Opening</span><input name="opening" type="number" step="0.01" defaultValue={(r.statement.opening / 100).toFixed(2)} key={`o${month}${stmt?.opening}`} /></label>
            <label className="ctl"><span>Closing</span><input name="closing" type="number" step="0.01" defaultValue={(r.statement.closing / 100).toFixed(2)} key={`c${month}${stmt?.closing}`} /></label>
            <button className="btn ghost sm">Save</button>
          </form>
          <p className="muted small" style={{ marginTop: 12 }}>Type them from the first page of the bank statement. If the lines on the statement do not add up from opening to closing, a page is missing and you will see it as a finding.</p>
          {r.statementGap !== 0 && <p className="error small">Opening plus this month’s lines is {money(r.statement.opening + r.movement)}, not {money(r.statement.closing)}.</p>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Trust account</h2><Link href={`/app/p/${project.id}/data${location.search}`} className="linkish small">Settings and data</Link></div>
          <dl className="mini-stats" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div><dt>Rules</dt><dd>{JURISDICTIONS[project.config.jurisdiction].label}</dd></div>
            <div><dt>Currency</dt><dd>{project.config.currency}</dd></div>
            <div><dt>Bank lines this month</dt><dd>{r.bankLines.length}</dd></div>
            <div><dt>Journal entries this month</dt><dd>{inMonth.length}</dd></div>
          </dl>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Client ledgers at {fmtDate(r.end)}</h2><span className="muted small">{r.clientSource === 'imported' ? 'Report balance compared with the journal' : 'Derived from the journal; import a trust listing to compare'}</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Matter</th><th>Client</th><th className="num">Balance</th><th className="num hide-sm">Journal</th><th className="num hide-sm">Lowest this month</th><th className="hide-sm">Last activity</th></tr></thead>
            <tbody>
              {r.clients.map(c => {
                const off = c.imported !== undefined && c.imported !== c.derived
                return (
                  <tr key={c.matter} className={c.balance < 0 || c.minBalance < 0 ? 'row-bad' : off ? 'row-warn' : ''}>
                    <th scope="row" className="mono">{c.matter}</th>
                    <td>{c.client}</td>
                    <td className={`num${c.balance < 0 ? ' neg' : ''}`}>{money(c.balance)}</td>
                    <td className={`num hide-sm${off ? ' warn-text' : ' muted'}`}>{money(c.derived)}</td>
                    <td className={`num hide-sm${c.minBalance < 0 ? ' neg' : ' muted'}`}>{money(c.minBalance)}</td>
                    <td className="hide-sm muted">{c.lastActivity ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot><tr><th scope="row" colSpan={2}>Total</th><td className="num">{money(r.clientTotal)}</td><td className="num hide-sm">{money(r.clients.reduce((a, c) => a + c.derived, 0))}</td><td className="hide-sm" colSpan={2} /></tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}

function groupBankOnly(r: MonthRecon) {
  const by = new Map<string, { label: string; n: number; amount: number }>()
  const kindOf = new Map(r.exceptions.flatMap(e => e.bankIds.map(id => [id, e.kind] as const)))
  const labels: Record<string, string> = { transfer: 'Transfers to operating not in the journal', bankfee: 'Bank fees not in the journal', interest: 'Interest not in the journal', unrecorded: 'Other statement lines not in the journal' }
  for (const b of r.bankOnly) {
    const k = kindOf.get(b.id) ?? 'unrecorded'
    const g = by.get(k) ?? { label: labels[k] ?? labels.unrecorded, n: 0, amount: 0 }
    g.n++; g.amount += b.amount
    by.set(k, g)
  }
  return [...by.values()]
}
