import { useMemo, useRef, useState } from 'react'
import { monthEnd, monthOf } from './engine/dates.ts'
import { assignBankIds, assignBookIds, autoMap, decodeText, detect, dropPreamble, isOfx, KINDS, parseCsv, parseOfx, statementsFromBalances, toCsv, validate, type Issue, type Kind, type Mapping } from './engine/importer.ts'
import type { MonthRecon } from './engine/recon.ts'
import { SAMPLES, sampleFiles } from './engine/sample.ts'
import { EMPTY_DATASET, type BankLine, type BookEntry, type Config, type Dataset, type LedgerBalance } from './engine/types.ts'
import { createBlankProject, JURISDICTIONS } from './projectData.ts'
import { getPrefs, putData, saveProject, uuid, type Project } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, fmtMonth, go, Link, money, plural, toast } from './ui.tsx'

interface Pending {
  id: string
  name: string
  format: string
  kind: Kind | null
  hasHeader: boolean
  csv?: ReturnType<typeof parseCsv>
  map: Mapping
  ofx?: ReturnType<typeof parseOfx>
  dayFirst: boolean
  asOf: string
}

const COLORS: Record<Kind, string> = { bank: 'var(--col-bank)', book: 'var(--col-book)', balances: 'var(--col-client)' }

export default function DataTab({ project, ds, update, setConfig, reload, recs }: { project: Project; ds: Dataset | null; update(p: Partial<Project>): void; setConfig(p: Partial<Config>): void; reload(): void; recs: Map<string, MonthRecon> }) {
  const data = ds ?? EMPTY_DATASET
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()
  const months = [...recs.keys()]
  const defaultAsOf = monthEnd(months.at(-1) ?? new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 7))

  const readFiles = async (files: FileList | File[]) => {
    setBusy(true)
    const next: Pending[] = []
    for (const f of [...files]) {
      if (f.size > 50_000_000) { toast(`${f.name} is over 50 MB. Export a single month instead.`, { tone: 'error' }); continue }
      const text = decodeText(await f.arrayBuffer())
      if (isOfx(text) || /\.(ofx|qfx)$/i.test(f.name)) {
        const ofx = parseOfx(text)
        next.push({ id: uuid(), name: f.name, format: /\.qfx$/i.test(f.name) || /INTU\./.test(text) ? 'QFX (Quicken / QuickBooks web connect)' : 'OFX statement', kind: 'bank', hasHeader: false, map: {}, ofx, dayFirst: false, asOf: defaultAsOf })
        continue
      }
      const parsed = parseCsv(text)
      if (parsed.rows.length < 1) { toast(`${f.name} is empty.`, { tone: 'error' }); continue }
      const d = detect(parsed.rows)
      const csv = dropPreamble(parsed, d.headerRow)
      next.push({ id: uuid(), name: f.name, format: d.format, kind: d.kind, hasHeader: d.hasHeader, csv, map: d.map, dayFirst: project.config.currency === 'CAD' && looksDayFirst(csv.rows), asOf: defaultAsOf })
    }
    setPending(p => [...p, ...next])
    setBusy(false)
  }

  const commit = async (p: Pending, rows: (BankLine | BookEntry | LedgerBalance)[], skipped: number) => {
    if (!p.kind) return
    let target = project
    let base = data
    if (project.sampleId) { target = await createBlankProject('My trust account'); base = EMPTY_DATASET }
    let next: Dataset
    let statements = { ...target.config.statements }
    if (p.kind === 'bank') {
      const lines = rows as BankLine[]
      const covered = new Set(lines.map(l => monthOf(l.date)))
      next = { ...base, bank: assignBankIds([...base.bank.filter(b => !covered.has(monthOf(b.date))), ...lines].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)) }
      const fromFile = statementsFromBalances(lines)
      if (p.ofx?.closing !== undefined) {
        const m = p.ofx.closingDate ? monthOf(p.ofx.closingDate) : [...covered].sort().at(-1)!
        const movement = lines.filter(l => monthOf(l.date) === m).reduce((a, l) => a + l.amount, 0)
        fromFile[m] = { opening: p.ofx.closing - movement, closing: p.ofx.closing }
      }
      for (const [m, v] of Object.entries(fromFile)) if (statements[m]?.source !== 'manual') statements[m] = { ...v, source: 'file' }
    } else if (p.kind === 'book') {
      const es = rows as BookEntry[]
      const dates = es.map(e => e.date).sort()
      const [lo, hi] = [dates[0], dates.at(-1)!]
      next = { ...base, book: assignBookIds([...base.book.filter(e => e.date < lo || e.date > hi), ...es].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)) }
    } else {
      const bs = rows as LedgerBalance[]
      const asOfs = new Set(bs.map(b => b.asOf))
      next = { ...base, balances: [...base.balances.filter(b => !asOfs.has(b.asOf)), ...bs] }
    }
    await putData(target.id, next)
    const meta = { id: uuid(), kind: p.kind, fileName: p.name, format: p.format, rows: rows.length, skipped, at: Date.now() }
    if (project.sampleId) {
      await saveProject({ ...target, imports: [meta], config: { ...target.config, statements } })
      setPending(x => x.filter(y => y.id !== p.id))
      toast(`Imported ${plural(rows.length, 'row')} into a new trust account. Samples stay read-only.`, { tone: 'ok' })
      go(`/app/p/${target.id}/data`)
      return
    }
    update({ imports: [...project.imports, meta], dataMissing: false, config: { ...project.config, statements } })
    setPending(x => x.filter(y => y.id !== p.id))
    reload()
    toast(`Imported ${plural(rows.length, 'row')} of ${KINDS[p.kind].title.toLowerCase()}${skipped ? `, skipped ${skipped}` : ''}`, { tone: 'ok' })
  }

  const counts: Record<Kind, number> = { bank: data.bank.length, book: data.book.length, balances: data.balances.length }
  const rawSize = useMemo(() => project.sampleId ? 0 : JSON.stringify(data).length, [data, project.sampleId])
  const cfg = project.config

  return (
    <div className="tab-body">
      {project.dataMissing && <div className="fix-banner warn"><div><strong>The statements and ledgers for this account are on another device.</strong><p className="small">Totals, sign-offs and history synced; client detail and raw files never leave the device they were imported on. Re-import the files here to work on a month.</p></div></div>}

      <div className="panel">
        <div className="panel-head wrap"><h2>Import</h2><Link href="/docs#clio" className="linkish small">How to export from Clio, QuickBooks and your bank &rarr;</Link></div>
        {project.sampleId && (
          <div className="fix-banner" style={{ background: 'var(--stone)', borderColor: 'var(--stone-2)' }}>
            <p className="small" style={{ margin: 0 }}>This is a synthetic firm, so its data is read-only. Importing here starts a new trust account with your files. To rehearse, download this firm’s October files and drop them in.</p>
            <button type="button" className="btn ghost sm" onClick={() => {
              const def = SAMPLES.find(s => s.id === project.sampleId)!
              Object.entries(sampleFiles(def, data, '2026-10')).forEach(([n, v], i) => setTimeout(() => download(n, v), i * 300))
            }}>Download sample files</button>
          </div>
        )}
        <div className={`dropzone${drag ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}>
          <div className="drop-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg></div>
          <p style={{ fontSize: '1.1rem' }}><strong>Drop your files here</strong> or <button type="button" className="linkish" onClick={() => input.current?.click()}>choose files</button></p>
          <p className="muted small">Bank statement (CSV, OFX, QFX), trust journal (Clio trust ledger, QuickBooks, any CSV) and client balances (Clio trust listing or any CSV). Each file’s type is detected from its columns. Read in your browser; nothing is uploaded.</p>
          <input ref={input} type="file" accept=".csv,.tsv,.txt,.ofx,.qfx,text/csv" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
          {busy && <p role="status"><span className="spinner" /> Reading files</p>}
        </div>
        {pending.map(p => <PendingCard key={p.id} p={p} onChange={np => setPending(x => x.map(y => y.id === p.id ? np : y))} onCancel={() => setPending(x => x.filter(y => y.id !== p.id))} onCommit={commit} />)}
      </div>

      <div className="panel">
        <div className="panel-head"><h2>What’s loaded</h2>{months.length > 0 && <span className="muted small">Statements {fmtMonth(months[0])} to {fmtMonth(months.at(-1)!)}</span>}</div>
        <div className="coverage">
          {(Object.keys(KINDS) as Kind[]).map(k => (
            <div key={k} className={`cov ${counts[k] ? 'ok' : k === 'balances' ? 'optional' : 'missing'}`} style={{ ['--c' as string]: COLORS[k] }}>
              <span className="muted small">{KINDS[k].title}</span>
              <b>{counts[k] ? plural(counts[k], k === 'balances' ? 'balance' : k === 'bank' ? 'line' : 'entry', k === 'book' ? 'entries' : undefined) : k === 'balances' ? 'Optional' : 'Required'}</b>
              <small>{k === 'bank' ? 'What actually moved through the account' : k === 'book' ? 'Every receipt and payment you recorded' : 'Per-client balances from your system; derived from the journal if missing'}</small>
            </div>
          ))}
        </div>
        {project.imports.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="data">
              <thead><tr><th>File</th><th>Type</th><th className="hide-sm">Format</th><th className="num">Rows</th><th className="num">Skipped</th><th className="hide-sm">Imported</th></tr></thead>
              <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th scope="row" className="break">{i.fileName}</th><td>{KINDS[i.kind].short}</td><td className="hide-sm muted">{i.format}</td><td className="num">{i.rows.toLocaleString()}</td><td className="num">{i.skipped}</td><td className="hide-sm">{new Date(i.at).toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {!project.sampleId && rawSize > 200 && <p className="muted small" style={{ marginTop: 12 }}>Data on this device: {(rawSize / 1e6).toFixed(2)} MB. {sync.user ? getPrefs().totalsOnly ? 'Sync is set to totals only, so these files stay here.' : rawSize > RAW_SYNC_LIMIT ? 'Too large to sync; totals and sign-offs sync, files stay here.' : 'Small enough to sync with your account.' : 'Not synced: you are signed out.'}</p>}
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Account settings</h2><span className="muted small">Saved automatically</span></div>
        <div className="form-grid">
          <label className="field"><span>Account name</span><input defaultValue={project.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== project.name) update({ name: v }) }} /></label>
          <label className="field"><span>Bank account description</span><input defaultValue={cfg.accountName} onBlur={e => setConfig({ accountName: e.target.value.trim() || 'Trust account' })} /></label>
          <label className="field"><span>Rules to report against</span>
            <select value={cfg.jurisdiction} onChange={e => setConfig({ jurisdiction: e.target.value as Config['jurisdiction'] })}>{Object.entries(JURISDICTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          </label>
          <label className="field"><span>Currency</span>
            <select value={cfg.currency} onChange={e => setConfig({ currency: e.target.value as Config['currency'] })}><option value="USD">US dollar</option><option value="CAD">Canadian dollar</option></select>
          </label>
          <label className="field"><span>Matching window for deposits and transfers (days)</span><input type="number" min="0" max="30" defaultValue={cfg.settings.dateWindow} onBlur={e => setConfig({ settings: { ...cfg.settings, dateWindow: clamp(e.target.value, 0, 30) } })} /></label>
          <label className="field"><span>Dormant after (months without activity)</span><input type="number" min="1" max="60" defaultValue={cfg.settings.staleMonths} onBlur={e => setConfig({ settings: { ...cfg.settings, staleMonths: clamp(e.target.value, 1, 60) } })} /></label>
          <label className="field"><span>Firm name (report and letters)</span><input defaultValue={project.firm.name} onBlur={e => update({ firm: { ...project.firm, name: e.target.value } })} /></label>
          <label className="field"><span>Firm address</span><input defaultValue={project.firm.address} onBlur={e => update({ firm: { ...project.firm, address: e.target.value } })} /></label>
        </div>
      </div>

      {!project.sampleId && (counts.bank > 0 || counts.book > 0) && (
        <div className="panel">
          <div className="panel-head"><h2>Danger zone</h2></div>
          <div className="row between wrap gap">
            <p className="small" style={{ margin: 0 }}>Remove every imported file from this account on this device. Snapshots and sign-offs stay.</p>
            <button type="button" className="btn danger-ghost sm" onClick={async () => {
              if (!(await ask('Clear imported data?', 'Removes all statements, journal entries and balances from this account on this device. Snapshots are kept. You can undo for a few seconds.', 'Clear data'))) return
              const before = data, imports = project.imports
              await putData(project.id, EMPTY_DATASET)
              update({ imports: [] })
              reload()
              toast('Imported data cleared', { undo: () => { void putData(project.id, before).then(() => { update({ imports }); reload() }) } })
            }}>Clear imported data</button>
          </div>
        </div>
      )}
    </div>
  )
}

const clamp = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)))

function looksDayFirst(rows: string[][]): boolean {
  for (const r of rows.slice(1, 40)) for (const c of r) { const m = c.match(/^(\d{1,2})\/(\d{1,2})\/\d{4}/); if (m && +m[1] > 12) return true; if (m && +m[2] > 12) return false }
  return false
}

function PendingCard({ p, onChange, onCancel, onCommit }: { p: Pending; onChange(p: Pending): void; onCancel(): void; onCommit(p: Pending, rows: (BankLine | BookEntry | LedgerBalance)[], skipped: number): void }) {
  const headers = p.csv ? (p.hasHeader ? p.csv.rows[0] : p.csv.rows[0].map((_, i) => `Column ${i + 1}`)) : []
  const first = p.csv ? p.csv.rows[p.hasHeader ? 1 : 0] ?? [] : []
  const v = useMemo(() => {
    if (p.ofx) return { rows: p.ofx.lines, issues: p.ofx.issues, skipped: p.ofx.issues.length, total: p.ofx.lines.length + p.ofx.issues.length }
    return p.kind && p.csv ? validate(p.kind, p.csv, p.map, { hasHeader: p.hasHeader, dayFirst: p.dayFirst, asOf: p.asOf }) : null
  }, [p])
  const [showAll, setShowAll] = useState(false)
  const issues: Issue[] = v?.issues ?? []
  const errors = issues.filter(i => i.level !== 'skip')
  const total = v?.rows.reduce((a, r) => a + ('amount' in r ? r.amount : r.balance), 0) ?? 0
  const dates = v?.rows.map(r => 'date' in r ? r.date : r.asOf).filter(Boolean).sort() ?? []
  return (
    <div className="pending">
      <div className="row between wrap gap-sm">
        <div><strong className="break">{p.name}</strong> <span className="muted small">{p.format}{p.csv ? ` · ${plural(p.csv.rows.length - (p.hasHeader ? 1 : 0), 'row')}, ${headers.length} columns` : ''}</span></div>
        {p.csv && (
          <label className="ctl inline"><span>Detected as</span>
            <select value={p.kind ?? ''} onChange={e => { const k = (e.target.value || null) as Kind | null; onChange({ ...p, kind: k, map: k ? autoMap(k, p.csv!.rows[0]) : {} }) }}>
              <option value="">Unknown: pick a type</option>
              {(Object.keys(KINDS) as Kind[]).map(k => <option key={k} value={k}>{KINDS[k].title}</option>)}
            </select>
          </label>
        )}
      </div>
      {!p.kind ? <p className="warn-text small">The columns do not match a statement, journal or balance export we know. Pick the type, then map the columns.</p> : (
        <>
          {p.csv && (
            <>
              <div className="mapping">
                {KINDS[p.kind].fields.map(f => (
                  <label key={f.key} className="map-row">
                    <span>{f.label}{f.required && <b className="req" aria-label="required">*</b>}</span>
                    <select value={p.map[f.key] ?? ''} onChange={e => { const m = { ...p.map }; if (e.target.value === '') delete m[f.key]; else m[f.key] = Number(e.target.value); onChange({ ...p, map: m }) }} aria-invalid={f.required && p.map[f.key] === undefined}>
                      <option value="">Not in file</option>
                      {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </select>
                    <code className="sample">{p.map[f.key] !== undefined ? (first[p.map[f.key]] ?? '').slice(0, 32) || '(empty)' : f.hint ?? ''}</code>
                  </label>
                ))}
              </div>
              <div className="row gap wrap small">
                <label className="row gap-sm"><input type="checkbox" checked={p.hasHeader} onChange={e => onChange({ ...p, hasHeader: e.target.checked })} /> First row is a header</label>
                <label className="row gap-sm"><input type="checkbox" checked={p.dayFirst} onChange={e => onChange({ ...p, dayFirst: e.target.checked })} /> Dates are day first (31/10/2026)</label>
                {p.kind === 'balances' && p.map.asOf === undefined && <label className="ctl inline"><span>Balances as of</span><input type="date" value={p.asOf} onChange={e => onChange({ ...p, asOf: e.target.value })} style={{ width: 170 }} /></label>}
              </div>
            </>
          )}
          {v && (
            <div className={`report ${errors.length ? (v.rows.length ? 'warn' : 'bad') : 'good'}`}>
              <div className="row between wrap gap-sm">
                <span><b>{v.rows.length.toLocaleString()}</b> {v.rows.length === 1 ? 'row' : 'rows'} ready{dates.length ? `, ${dates[0]} to ${dates.at(-1)}` : ''}, net {money(total)}{v.skipped ? <>, <b>{v.skipped}</b> skipped</> : ''}{errors.length ? `, ${plural(errors.length, 'problem')}` : ', no problems'}</span>
                {issues.length > 0 && <button type="button" className="btn ghost sm" onClick={() => download(`${p.name.replace(/\.\w+$/, '')}-validation.csv`, toCsv([['line', 'level', 'issue'], ...issues.map(i => [i.line, i.level ?? 'error', i.message])]))}>Download report</button>}
              </div>
              {issues.length > 0 && (
                <ul className="issues">
                  {issues.slice(0, showAll ? 500 : 6).map((i, k) => <li key={k} className={i.level === 'skip' ? 'skip' : ''}><span className="mono">line {i.line}</span> {i.message}</li>)}
                  {issues.length > 6 && !showAll && <li><button type="button" className="linkish small" onClick={() => setShowAll(true)}>Show all {issues.length}</button></li>}
                </ul>
              )}
            </div>
          )}
          <div className="row end gap-sm">
            <button type="button" className="btn ghost sm" onClick={onCancel}>Discard</button>
            <button type="button" className="btn primary sm" disabled={!v || !v.rows.length} onClick={() => v && onCommit(p, v.rows as never, v.skipped)}>Import {v?.rows.length.toLocaleString()} rows</button>
          </div>
        </>
      )}
    </div>
  )
}
