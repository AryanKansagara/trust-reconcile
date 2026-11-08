import { useEffect, useState } from 'react'
import { SAMPLES } from './engine/sample.ts'
import { complianceCalendar } from './engine/snapshot.ts'
import { createBlankProject, createSampleProject, JURISDICTIONS } from './projectData.ts'
import { deleteProject, getPrefs, saveProject, useProjects, type Project } from './store.ts'
import { useSync } from './sync.ts'
import { ask, fmtMonth, go, Link, money, setCurrency, SyntheticBadge, toast } from './ui.tsx'

export default function Workspace() {
  const list = useProjects()
  const sync = useSync()
  const [busy, setBusy] = useState<string | null>(null)

  // /app?sample=reyes opens (or creates) the sample straight away.
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const s = q.get('sample')
    const tab = q.get('tab')?.replace(/[^a-z]/g, '')
    if (!s || list === null || busy) return
    if (!SAMPLES.some(x => x.id === s)) return
    setBusy(s)
    void createSampleProject(s).then(p => go(`/app/p/${p.id}${tab ? '/' + tab : ''}`, { replace: true }))
  }, [list, busy])

  const openSample = async (id: string) => { setBusy(id); const p = await createSampleProject(id); go(`/app/p/${p.id}`) }
  const newProject = async () => {
    const n = (list?.filter(p => !p.sampleId).length ?? 0) + 1
    const p = await createBlankProject(n === 1 ? 'IOLTA trust account' : `Trust account ${n}`)
    go(`/app/p/${p.id}/data`)
  }

  if (list === null || busy) return <div className="boot" role="status"><span className="spinner" /> {busy ? 'Setting up the synthetic firm' : 'Opening your reconciliations'}</div>

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Trust accounts</h1>
          <p className="muted">One project per trust bank account. Each keeps its monthly reconciliations, sign-offs and history. {sync.user ? (getPrefs().totalsOnly ? 'Totals sync to your account; client detail stays here.' : 'Synced to your account.') : 'Stored in this browser only.'}</p>
        </div>
        {list.length > 0 && <button type="button" className="btn primary" onClick={newProject}>New trust account</button>}
      </div>

      {list.length === 0 ? (
        <div className="onboard">
          <article className="onboard-card feature">
            <div className="eyebrow on-dark">Two minutes</div>
            <h2>Try a sample firm</h2>
            <p>Invented firms with six months of history, already reconciled. Open a month, read the findings, print the report.</p>
            <div className="stack-sm">
              {SAMPLES.map(s => (
                <button key={s.id} type="button" className="sample-btn" onClick={() => void openSample(s.id)}>
                  <span><strong>{s.name} · {s.location}</strong><small>{s.blurb}</small></span><span aria-hidden="true">&rarr;</span>
                </button>
              ))}
            </div>
          </article>
          <article className="onboard-card">
            <div className="eyebrow">Your account</div>
            <h2>Import your data</h2>
            <p>Download this month’s trust bank statement, then the trust ledger and trust listing reports from Clio Manage (or your QuickBooks register). Drop all three in; formats are detected and mapped for you.</p>
            <div className="row gap wrap">
              <button type="button" className="btn primary" onClick={newProject}>Import your data</button>
              <Link href="/docs" className="btn ghost">How to export</Link>
            </div>
            <p className="muted small" style={{ marginTop: 16 }}>Files are read in your browser and stay on this device. Nothing is uploaded.</p>
          </article>
        </div>
      ) : (
        <>
          <div className="project-grid">{list.map(p => <ProjectCard key={p.id} p={p} />)}</div>
          <div className="samples-row">
            <span className="muted small">Sample firms:</span>
            {SAMPLES.map(s => <button key={s.id} type="button" className="linkish small" onClick={() => void openSample(s.id)}>{s.name}</button>)}
          </div>
        </>
      )}
    </section>
  )
}

function ProjectCard({ p }: { p: Project }) {
  const [renaming, setRenaming] = useState(false)
  setCurrency(p.config.currency)
  const snaps = [...p.snapshots].sort((a, b) => a.month.localeCompare(b.month))
  const last = snaps.at(-1)
  const today = new Date().toISOString().slice(0, 10)
  const lastMonth = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 2, 1)).toISOString().slice(0, 7)
  const end = last && last.month > lastMonth ? last.month : lastMonth
  const cal = complianceCalendar(end, p.snapshots, [], p.config.jurisdiction, today)
  const signed = cal.filter(c => c.status === 'signed' || c.status === 'reviewed').length
  return (
    <article className="project-card">
      <div className="row between gap-sm">
        {renaming ? (
          <form onSubmit={e => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('n')).trim(); if (v) void saveProject({ ...p, name: v }); setRenaming(false) }}>
            <input name="n" defaultValue={p.name} autoFocus aria-label="Account name" onBlur={e => e.currentTarget.form?.requestSubmit()} />
          </form>
        ) : <h3><Link href={`/app/p/${p.id}`}>{p.name}</Link></h3>}
        {p.sampleId && <SyntheticBadge />}
      </div>
      <dl className="mini-stats">
        <div><dt>Last closed</dt><dd>{last ? fmtMonth(last.month) : 'None yet'}</dd></div>
        <div><dt>Journal</dt><dd>{last ? money(last.totals.journal, { cents: false }) : '—'}</dd></div>
        <div><dt>Status</dt><dd>{last ? (last.tiesOut ? <span className="chip good">Ties out</span> : <span className="chip critical">{last.counts.critical} critical</span>) : '—'}</dd></div>
      </dl>
      <div>
        <div className="row between small muted" style={{ marginBottom: 6 }}><span>Last 12 months</span><span>{signed} of 12 signed · {JURISDICTIONS[p.config.jurisdiction].short}</span></div>
        <div className="mini-cal" aria-label={`${signed} of the last 12 months signed`}>{cal.map(c => <i key={c.month} className={c.overdue && c.status !== 'none' ? 'overdue' : c.status} title={`${fmtMonth(c.month)}: ${c.status}`} />)}</div>
      </div>
      {p.dataMissing && <p className="warn-text small">The statements and ledgers live on another device. Re-import them here to work on a month.</p>}
      <div className="row between">
        <span className="muted small">Updated {new Date(p.updatedAt).toLocaleDateString()}</span>
        <div className="row gap-sm">
          <button type="button" className="btn ghost sm" onClick={() => setRenaming(true)}>Rename</button>
          <button type="button" className="btn danger-ghost sm" onClick={async () => {
            if (!(await ask(`Delete “${p.name}”?`, 'Removes the account, its imported files and its monthly snapshots from this device (and the cloud, if you are signed in). You can undo for a few seconds.', 'Delete'))) return
            const undo = await deleteProject(p.id)
            toast(`Deleted ${p.name}`, { undo: () => void undo() })
          }}>Delete</button>
        </div>
      </div>
    </article>
  )
}
