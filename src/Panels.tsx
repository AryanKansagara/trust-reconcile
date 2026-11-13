import { useMemo, useState } from 'react'
import { dayNum } from './engine/dates.ts'
import { toCsv } from './engine/importer.ts'
import { matchKey } from './engine/match.ts'
import { EX_LABEL, correctionRows, type Exception, type Severity } from './engine/recon.ts'
import { complianceCalendar } from './engine/snapshot.ts'
import type { BankLine, BookEntry } from './engine/types.ts'
import { correctionsCsv, type Tab, type TabProps } from './Project.tsx'
import { deleteSnapshotCloud } from './sync.ts'
import type { Snapshot } from './store.ts'
import { ask, CopyButton, download, Empty, fmtDay, fmtMonth, fmtMonthShort, go, Link, money, plural, toast } from './ui.tsx'

export default function Panels(props: TabProps & { tab: Tab }) {
  switch (props.tab) {
    case 'matching': return <Matching {...props} />
    case 'exceptions': return <Exceptions {...props} />
    case 'letters': return <LettersTab {...props} />
    case 'history': return <History {...props} />
    default: return null
  }
}

// ---------- Matching and the cleared-items worklist ----------

function Matching({ project, ds, r, setConfig }: TabProps) {
  const [selBank, setSelBank] = useState<Set<string>>(new Set())
  const [selBook, setSelBook] = useState<Set<string>>(new Set())
  const [showMatched, setShowMatched] = useState(true)
  const bankById = useMemo(() => new Map(ds.bank.map(b => [b.id, b])), [ds])
  const bookById = useMemo(() => new Map(ds.book.map(e => [e.id, e])), [ds])
  const outstanding = [...r.outstandingDeposits, ...r.outstandingCheques].sort((a, b) => a.date.localeCompare(b.date))
  const age = (d: string) => dayNum(r.end) - dayNum(d)
  const toggle = (set: Set<string>, id: string, f: (s: Set<string>) => void) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); f(n) }
  const sumBank = [...selBank].reduce((a, id) => a + (bankById.get(id)?.amount ?? 0), 0)
  const sumBook = [...selBook].reduce((a, id) => a + (bookById.get(id)?.amount ?? 0), 0)
  const cfg = project.config

  const matchSelected = () => {
    const prev = { manual: cfg.manual, rejected: cfg.rejected }
    setConfig({ manual: [...cfg.manual, { bank: [...selBank], book: [...selBook] }] })
    toast(`Matched ${plural(selBank.size, 'bank line')} to ${plural(selBook.size, 'journal entry', 'journal entries')}`, { tone: 'ok', undo: () => setConfig(prev) })
    setSelBank(new Set()); setSelBook(new Set())
  }
  const unmatch = (bank: string[], book: string[], how: string) => {
    const prev = { manual: cfg.manual, rejected: cfg.rejected }
    const key = matchKey(bank, book)
    if (how === 'manual') setConfig({ manual: cfg.manual.filter(m => matchKey(m.bank, m.book) !== key) })
    else setConfig({ rejected: [...cfg.rejected, key] })
    toast('Unmatched. The engine will not pair these again.', { undo: () => setConfig(prev) })
  }

  const worklist = () => {
    const rows: (string | number)[][] = [['status', 'side', 'date', 'cleared_on', 'reference', 'matter', 'description', 'amount', 'age_days', 'action']]
    for (const m of r.matches) {
      const bs = m.bank.map(id => bankById.get(id)!)
      for (const id of m.book) { const e = bookById.get(id)!; rows.push(['cleared', 'journal', e.date, bs[0].date, e.ref, e.matter, e.desc, (e.amount / 100).toFixed(2), '', `tick as cleared (${m.how})`]) }
    }
    for (const e of outstanding) rows.push([e.amount > 0 ? 'deposit in transit' : 'outstanding cheque', 'journal', e.date, '', e.ref, e.matter, e.desc || e.payee, (e.amount / 100).toFixed(2), age(e.date), age(e.date) > 30 ? 'follow up' : 'carry forward'])
    for (const b of r.bankOnly) rows.push(['not in journal', 'bank', b.date, b.date, b.ref, '', b.desc, (b.amount / 100).toFixed(2), age(b.date), 'record in the journal'])
    download(`cleared-items-${r.month}.csv`, toCsv(rows))
  }

  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head">
          <h2>Cleared-items worklist</h2>
          <button type="button" className="btn ghost sm" onClick={worklist}>Download worklist CSV</button>
        </div>
        <p className="muted small">Tick these off against the statement. Outstanding items carry into next month automatically and clear when they show up on a later statement. Select a bank line and the journal entries it covers to match them by hand.</p>
        <div className="grid-2">
          <div>
            <h3>Outstanding in the journal <span className="muted small">({outstanding.length}, {money(r.dit + r.oc)})</span></h3>
            {outstanding.length ? (
              <div className="table-wrap"><table className="data">
                <thead><tr><th><span className="sr">Select</span></th><th>Date</th><th>Item</th><th className="num">Amount</th><th className="num">Age</th></tr></thead>
                <tbody>{outstanding.map(e => (
                  <tr key={e.id} className={selBook.has(e.id) ? 'sel' : ''}>
                    <td><input type="checkbox" aria-label={`Select ${e.desc}`} checked={selBook.has(e.id)} onChange={() => toggle(selBook, e.id, setSelBook)} /></td>
                    <td className="mono">{fmtDay(e.date)}</td>
                    <td><div>{e.amount > 0 ? 'Deposit in transit' : `Cheque${e.ref ? ` #${e.ref}` : ''}`}</div><div className="muted small">{e.matter || 'No client'} · {e.payee || e.desc}</div></td>
                    <td className={`num${e.amount < 0 ? ' neg' : ''}`}>{money(e.amount)}</td>
                    <td className="num"><span className={`age${age(e.date) > 30 ? ' old' : ''}`}>{age(e.date)}d</span></td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <p className="muted small">Nothing outstanding. Every journal entry cleared the bank.</p>}
          </div>
          <div>
            <h3>On the statement, not in the journal <span className="muted small">({r.bankOnly.length}, {money(r.bankOnlyTotal)})</span></h3>
            {r.bankOnly.length ? (
              <div className="table-wrap"><table className="data">
                <thead><tr><th><span className="sr">Select</span></th><th>Date</th><th>Bank description</th><th className="num">Amount</th></tr></thead>
                <tbody>{r.bankOnly.map(b => (
                  <tr key={b.id} className={selBank.has(b.id) ? 'sel' : ''}>
                    <td><input type="checkbox" aria-label={`Select ${b.desc}`} checked={selBank.has(b.id)} onChange={() => toggle(selBank, b.id, setSelBank)} /></td>
                    <td className="mono">{fmtDay(b.date)}</td>
                    <td>{b.desc}{b.ref && <span className="muted"> #{b.ref}</span>}</td>
                    <td className={`num${b.amount < 0 ? ' neg' : ''}`}>{money(b.amount)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <p className="muted small">Every statement line has a journal entry.</p>}
          </div>
        </div>
        {(selBank.size > 0 || selBook.size > 0) && (
          <div className="match-bar" role="region" aria-label="Manual match">
            <span>Bank {money(sumBank)} · Journal {money(sumBook)} {selBank.size && selBook.size && sumBank !== sumBook ? <b> · differs by {money(sumBank - sumBook)}</b> : ''}</span>
            <div className="row gap-sm">
              <button type="button" className="btn ghost sm on-dark" style={{ color: 'inherit' }} onClick={() => { setSelBank(new Set()); setSelBook(new Set()) }}>Clear</button>
              <button type="button" className="btn primary sm" disabled={!selBank.size || !selBook.size || sumBank !== sumBook} onClick={matchSelected}>Match selected</button>
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Matched this month <span className="muted small">({r.matches.length})</span></h2>
          <button type="button" className="linkish small" onClick={() => setShowMatched(s => !s)}>{showMatched ? 'Hide' : 'Show all'}</button>
        </div>
        <p className="muted small">Cheques match by number, everything else by amount within {cfg.settings.dateWindow} days, and a single deposit can cover several receipts (up to {cfg.settings.batchMax}).</p>
        {showMatched && (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>How</th><th>Bank</th><th>Journal</th><th className="num">Amount</th><th className="num">Days</th><th /></tr></thead>
            <tbody>{r.matches.map(m => {
              const bs = m.bank.map(id => bankById.get(id)).filter(Boolean) as BankLine[]
              const es = m.book.map(id => bookById.get(id)).filter(Boolean) as BookEntry[]
              return (
                <tr key={m.key}>
                  <td><span className={`how ${m.how}`}>{m.how}</span></td>
                  <td>{bs.map(b => <div key={b.id}><span className="mono muted">{fmtDay(b.date)}</span> {b.desc}</div>)}</td>
                  <td>{es.map(e => <div key={e.id}><span className="mono muted">{fmtDay(e.date)}</span> {e.matter || 'No client'} · {e.desc}{es.length > 1 && <span className="muted"> {money(e.amount)}</span>}</div>)}</td>
                  <td className="num">{money(bs.reduce((a, b) => a + b.amount, 0))}</td>
                  <td className="num">{m.gap}</td>
                  <td><button type="button" className="linkish small" onClick={() => unmatch(m.bank, m.book, m.how)}>Unmatch</button></td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </div>
    </div>
  )
}

// ---------- Exceptions ----------

const SEV_LABEL: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' }

function Exceptions({ r, month }: TabProps) {
  const [filter, setFilter] = useState<string>('all')
  const kinds = [...new Set(r.exceptions.map(e => e.kind))]
  const list = r.exceptions.filter(e => filter === 'all' || e.kind === filter || e.severity === filter)
  if (!r.exceptions.length) return <Empty title="No findings this month"><p className="muted">No negative ledgers, no stray transfers, no fees in trust. Close the month and sign the report.</p></Empty>
  return (
    <div className="tab-body">
      <div className="panel-head">
        <div className="ex-filters" role="group" aria-label="Filter findings">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {r.exceptions.length}</button>
          {(['critical', 'warning', 'info'] as Severity[]).filter(s => r.exceptions.some(e => e.severity === s)).map(s => <button type="button" key={s} aria-pressed={filter === s} onClick={() => setFilter(s)}>{SEV_LABEL[s]} {r.exceptions.filter(e => e.severity === s).length}</button>)}
          {kinds.map(k => <button type="button" key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{EX_LABEL[k]}</button>)}
        </div>
        <button type="button" className="btn primary sm" onClick={() => download(`correcting-entries-${month}.csv`, correctionsCsv(r))}>Correcting entries CSV</button>
      </div>
      <div className="ex-list">{list.map(e => <ExceptionCard key={e.id} e={e} />)}</div>
    </div>
  )
}

function ExceptionCard({ e }: { e: Exception }) {
  const csv = e.fix.length ? toCsv(correctionRows({ exceptions: [e] } as never).slice(1)) : ''
  return (
    <article className={`ex ${e.severity}`}>
      <div className="ex-head">
        <div>
          <div className="row gap-sm wrap" style={{ marginBottom: 6 }}><span className={`chip ${e.severity}`}>{SEV_LABEL[e.severity]}</span><span className="muted small">{EX_LABEL[e.kind]}{e.date && !e.date.startsWith('0000') ? ` · ${fmtDay(e.date)}` : ''}</span></div>
          <h3>{e.title}</h3>
        </div>
        <span className={`ex-amt${e.amount < 0 ? ' neg' : ''}`}>{money(e.amount)}</span>
      </div>
      <p>{e.detail}</p>
      {e.fix.length > 0 && (
        <div className="ex-fix">
          <div className="table-wrap"><table>
            <caption>Suggested correcting {e.fix.length === 1 ? 'entry' : 'entries'}</caption>
            <tbody>{e.fix.map((f, i) => <tr key={i}><td className="mono">{f.date}</td><td>{f.type}</td><td className="mono">{f.matter}</td><td>{f.description}</td><td className={`num${f.amount < 0 ? ' neg' : ''}`}>{money(f.amount)}</td></tr>)}</tbody>
          </table></div>
          <div className="row end" style={{ marginTop: 6 }}><CopyButton text={csv} label="Copy as CSV" /></div>
        </div>
      )}
    </article>
  )
}

// ---------- Letters for dormant balances ----------

function LettersTab({ project, r, month }: TabProps) {
  const stale = r.exceptions.filter(e => e.kind === 'stale')
  const [sel, setSel] = useState<Set<string>>(() => new Set(stale.map(e => e.matter!)))
  if (!stale.length) return <Empty title="No dormant balances"><p className="muted">No client has money sitting in trust for {project.config.settings.staleMonths}+ months without activity. Change the threshold in <Link href="/settings">Settings</Link>.</p></Empty>
  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head"><h2>Dormant balances</h2><span className="muted small">No activity for {project.config.settings.staleMonths}+ months</span></div>
        <p className="muted small">Draft a letter asking each client to confirm instructions or accept the return of their funds. Letters open on a printable page where you can edit the wording and letterhead.</p>
        <div className="table-wrap"><table className="data">
          <thead><tr><th /><th>Matter</th><th>Client</th><th>Last activity</th><th className="num">Balance</th></tr></thead>
          <tbody>{stale.map(e => (
            <tr key={e.id} className={sel.has(e.matter!) ? 'sel' : ''}>
              <td><input type="checkbox" aria-label={`Include ${e.client}`} checked={sel.has(e.matter!)} onChange={() => { const n = new Set(sel); if (n.has(e.matter!)) n.delete(e.matter!); else n.add(e.matter!); setSel(n) }} /></td>
              <th scope="row" className="mono">{e.matter}</th><td>{e.client}</td><td>{e.date}</td><td className="num">{money(e.amount)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="row end" style={{ marginTop: 16 }}>
          <button type="button" className="btn primary" disabled={!sel.size} onClick={() => go(`/app/p/${project.id}/drafts?m=${month}&matters=${encodeURIComponent([...sel].join(','))}`)}>Draft {plural(sel.size, 'letter')}</button>
        </div>
      </div>
    </div>
  )
}

// ---------- History: snapshots, compare, compliance calendar ----------

function History({ project, recs, month, update }: TabProps) {
  const snaps = [...project.snapshots].sort((a, b) => a.month.localeCompare(b.month))
  const [a, setA] = useState(() => snaps.at(-2)?.id ?? '')
  const [b, setB] = useState(() => snaps.at(-1)?.id ?? '')
  const today = new Date().toISOString().slice(0, 10)
  const months = [...recs.keys()]
  const last = [months.at(-1) ?? '', snaps.at(-1)?.month ?? ''].sort().at(-1) || today.slice(0, 7)
  const cal = complianceCalendar(last, project.snapshots, months, project.config.jurisdiction, today)
  const sa = snaps.find(s => s.id === a), sb = snaps.find(s => s.id === b)

  const del = async (s: Snapshot) => {
    if (!(await ask(`Delete the ${fmtMonth(s.month)} snapshot?`, s.signoff ? 'This month was signed. Deleting removes the sign-off record too. You can undo for a few seconds.' : 'You can close the month again at any time. You can undo for a few seconds.', 'Delete snapshot'))) return
    const prev = project.snapshots
    void update({ snapshots: prev.filter(x => x.id !== s.id) })
    void deleteSnapshotCloud(s.id)
    toast(`Deleted the ${fmtMonth(s.month)} snapshot`, { undo: () => void update({ snapshots: prev }) })
  }

  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head"><h2>Compliance calendar</h2><span className="muted small">Due {project.config.jurisdiction === 'on' ? '25 days after month end (By-Law 9)' : project.config.jurisdiction === 'bc' ? '30 days after month end (Rule 3-73)' : 'by the end of the following month'}</span></div>
        <div className="cal">
          {cal.map(c => {
            const st = c.overdue ? 'overdue' : c.status
            const label = { reviewed: 'Signed + reviewed', signed: 'Signed', reconciled: 'Not signed', data: 'Not closed', none: 'No data' }[c.status]
            const body = <><b>{fmtMonthShort(c.month)}</b><span className="muted">{c.month.slice(0, 4)}</span><span className="st">{c.overdue && c.status !== 'signed' && c.status !== 'reviewed' ? `${label} · overdue` : label}</span></>
            return recs.has(c.month)
              ? <button type="button" key={c.month} className={`cal-cell ${st}`} onClick={() => go(`/app/p/${project.id}?m=${c.month}`)} aria-label={`${fmtMonth(c.month)}: ${label}`}>{body}</button>
              : <div key={c.month} className={`cal-cell ${st}`}>{body}</div>
          })}
        </div>
        <div className="legend small">
          <span><i style={{ background: 'var(--good-bg)', borderColor: 'var(--good-line)' }} />Signed</span>
          <span><i style={{ background: 'var(--warn-bg)', borderColor: 'var(--warn-line)' }} />Closed, not signed</span>
          <span><i style={{ background: 'var(--bad-bg)', borderColor: 'var(--bad-line)' }} />Overdue</span>
          <span><i style={{ background: 'var(--bg-2)', borderStyle: 'dashed' }} />No data</span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Monthly snapshots</h2><span className="muted small">Close a month with <kbd>S</kbd>; sign it on the report</span></div>
        {snaps.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Month</th><th>Result</th><th className="num">Adjusted bank</th><th className="num hide-sm">Journal</th><th className="num hide-sm">Client ledgers</th><th className="num">Findings</th><th>Sign-off</th><th /></tr></thead>
            <tbody>{[...snaps].reverse().map(s => (
              <tr key={s.id} className={s.month === month ? 'sel' : ''}>
                <th scope="row"><Link href={`/app/p/${project.id}?m=${s.month}`}>{fmtMonth(s.month)}</Link></th>
                <td>{s.tiesOut ? <span className="chip good">Ties out</span> : <span className="chip critical">Off</span>}</td>
                <td className="num">{money(s.totals.adjustedBank)}</td>
                <td className="num hide-sm">{money(s.totals.journal)}</td>
                <td className="num hide-sm">{money(s.totals.clientTotal)}</td>
                <td className="num">{s.counts.critical ? <span className="neg">{s.counts.critical} critical</span> : s.counts.warning + s.counts.info}</td>
                <td className="small">{s.signoff ? <>{s.signoff.reconciler}<br /><span className="muted">{s.signoff.reviewer ? `Reviewed by ${s.signoff.reviewer}` : 'Not reviewed'}</span></> : <Link href={`/app/p/${project.id}/report?m=${s.month}`}>Sign</Link>}</td>
                <td><button type="button" className="linkish small" onClick={() => void del(s)}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No closed months yet"><p className="muted">Close a month to keep a record of its totals, findings and sign-off.</p></Empty>}
      </div>

      {snaps.length >= 2 && (
        <div className="panel">
          <div className="panel-head wrap">
            <h2>Compare months</h2>
            <div className="row gap-sm wrap">
              <label className="ctl inline"><span>From</span><select value={a} onChange={e => setA(e.target.value)}>{snaps.map(s => <option key={s.id} value={s.id}>{fmtMonth(s.month)}</option>)}</select></label>
              <label className="ctl inline"><span>To</span><select value={b} onChange={e => setB(e.target.value)}>{snaps.map(s => <option key={s.id} value={s.id}>{fmtMonth(s.month)}</option>)}</select></label>
            </div>
          </div>
          {sa && sb && <Compare a={sa} b={sb} />}
        </div>
      )}
    </div>
  )
}

function Compare({ a, b }: { a: Snapshot; b: Snapshot }) {
  const rows: [string, number, number][] = [
    ['Statement closing', a.totals.closing, b.totals.closing],
    ['Deposits in transit', a.totals.dit, b.totals.dit],
    ['Outstanding cheques', a.totals.oc, b.totals.oc],
    ['Adjusted bank', a.totals.adjustedBank, b.totals.adjustedBank],
    ['Trust journal', a.totals.journal, b.totals.journal],
    ['Client ledgers', a.totals.clientTotal, b.totals.clientTotal],
    ['Journal entries with no client', a.totals.unallocated, b.totals.unallocated],
  ]
  const carried = b.outstanding.filter(o => a.outstanding.some(x => x.id === o.id))
  const cleared = a.outstanding.filter(o => !b.outstanding.some(x => x.id === o.id))
  const kinds = [...new Set([...a.exceptions, ...b.exceptions].map(e => e.kind))]
  const matters = [...new Set([...(a.clients ?? []), ...(b.clients ?? [])].map(c => c.matter))].sort()
  const bal = (s: Snapshot, m: string) => s.clients?.find(c => c.matter === m)?.balance ?? 0
  const changed = matters.map(m => ({ m, client: (b.clients ?? a.clients ?? []).find(c => c.matter === m)?.client ?? '', from: bal(a, m), to: bal(b, m) })).filter(x => x.from !== x.to)
  return (
    <div className="grid-2">
      <div>
        <table className="data">
          <thead><tr><th /><th className="num">{fmtMonthShort(a.month)}</th><th className="num">{fmtMonthShort(b.month)}</th><th className="num">Change</th></tr></thead>
          <tbody>{rows.map(([l, x, y]) => <tr key={l}><th scope="row">{l}</th><td className="num">{money(x)}</td><td className="num">{money(y)}</td><td className={`num delta${y - x ? '' : ' muted'}`}>{money(y - x, { sign: true })}</td></tr>)}</tbody>
        </table>
        <h3 style={{ marginTop: 24 }}>Findings by type</h3>
        {!kinds.length && <p className="muted small">No findings in either month.</p>}
        <table className="data">
          <tbody>{kinds.map(k => { const x = a.exceptions.filter(e => e.kind === k).length, y = b.exceptions.filter(e => e.kind === k).length; return <tr key={k}><th scope="row">{EX_LABEL[k]}</th><td className="num">{x}</td><td className="num">{y}</td><td className={`num delta ${y > x ? 'up' : y < x ? 'down' : 'muted'}`}>{y - x > 0 ? '+' : ''}{y - x}</td></tr> })}</tbody>
        </table>
      </div>
      <div>
        <h3>Outstanding items</h3>
        <p className="small">{plural(cleared.length, 'item')} outstanding at {fmtMonthShort(a.month)} cleared by {fmtMonthShort(b.month)}; {plural(carried.length, 'item')} still outstanding; {plural(b.outstanding.length - carried.length, 'new item')}.</p>
        {carried.length > 0 && <ul className="explain-list small">{carried.map(o => <li key={o.id}><span>{o.date} {o.ref ? `#${o.ref}` : ''} {o.payee ?? ''}</span><span className="num">{money(o.amount)}</span></li>)}</ul>}
        <h3 style={{ marginTop: 24 }}>Client balances that changed</h3>
        {a.clients && b.clients ? (changed.length ? (
          <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}><table className="data">
            <tbody>{changed.map(c => <tr key={c.m}><th scope="row" className="mono small">{c.m}</th><td className="small">{c.client}</td><td className="num small">{money(c.to)}</td><td className={`num small delta${c.to < 0 ? ' neg' : ''}`}>{money(c.to - c.from, { sign: true })}</td></tr>)}</tbody>
          </table></div>
        ) : <p className="muted small">No client balance changed.</p>) : <p className="muted small">Client detail is kept only on the device that closed the month, and one of these snapshots came from another device.</p>}
      </div>
    </div>
  )
}
