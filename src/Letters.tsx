import { useEffect, useState } from 'react'
import { pickMonth, useProject, useRecons } from './projectData.ts'
import { fmtDate, Link, money, ThemeToggle } from './ui.tsx'

const KEY = 'trust-reconcile.letterTemplate'
const DEFAULT = `Dear {client},

Re: Funds held in trust, matter {matter}

Our records show that we hold {balance} in our trust account on your behalf for the matter above. There has been no activity on this matter since {lastActivity}.

Unless we need these funds for work still to be done, we would like to return them to you. Please let us know within 30 days whether you would like the balance returned, and confirm the address or account it should be sent to. If you have instructions for us to continue holding the funds, please tell us that instead.

If we cannot reach you, our professional rules may require us to deal with the funds as unclaimed trust money.

Thank you,

{signatory}
{firm}`

export default function Letters({ id }: { id: string }) {
  const { loading, project, ds, update } = useProject(id)
  const recs = useRecons(ds, project?.config)
  const month = pickMonth(recs)
  const r = month ? recs.get(month) : undefined
  const [tpl, setTpl] = useState(() => localStorage.getItem(KEY) ?? DEFAULT)
  useEffect(() => { localStorage.setItem(KEY, tpl) }, [tpl])
  useEffect(() => { document.title = 'Client letters · Trust Reconcile' }, [])

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Drafting letters</div>
  if (!project || !r) return <div className="page narrow center notfound"><h1>No letters to draft</h1><Link href="/app" className="btn primary">Back</Link></div>

  const want = new Set((new URLSearchParams(location.search).get('matters') ?? '').split(',').filter(Boolean))
  const stale = r.exceptions.filter(e => e.kind === 'stale' && (!want.size || want.has(e.matter!)))
  const today = fmtDate(new Date().toISOString().slice(0, 10))
  const fill = (e: (typeof stale)[number]) => tpl
    .replaceAll('{client}', e.client || 'Client').replaceAll('{matter}', e.matter ?? '').replaceAll('{balance}', money(e.amount))
    .replaceAll('{lastActivity}', e.date ? fmtDate(e.date) : 'some time').replaceAll('{firm}', project.firm.name || project.name)
    .replaceAll('{signatory}', project.firm.signatory || project.firm.reviewer || '').replaceAll('{date}', today)

  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <Link href={`/app/p/${id}/letters?m=${month}`} className="btn ghost sm">&larr; {project.name}</Link>
        <span className="muted small">{stale.length} letter{stale.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <ThemeToggle />
        <button type="button" className="btn ghost sm" onClick={() => setTpl(DEFAULT)}>Reset wording</button>
        <button type="button" className="btn primary sm" onClick={() => print()}>Print letters</button>
      </div>
      <div className="letter-edit panel">
        <div className="form-grid">
          <label className="field"><span>Firm name</span><input defaultValue={project.firm.name} onBlur={e => update({ firm: { ...project.firm, name: e.target.value } })} /></label>
          <label className="field"><span>Signed by</span><input defaultValue={project.firm.signatory} onBlur={e => update({ firm: { ...project.firm, signatory: e.target.value } })} /></label>
          <label className="field" style={{ gridColumn: '1 / -1' }}><span>Letterhead address</span><input defaultValue={project.firm.address} onBlur={e => update({ firm: { ...project.firm, address: e.target.value } })} /></label>
        </div>
        <label className="field" style={{ marginTop: 14 }}><span>Wording · placeholders {'{client} {matter} {balance} {lastActivity} {firm} {signatory}'}</span><textarea rows={12} value={tpl} onChange={e => setTpl(e.target.value)} /></label>
      </div>
      {stale.map(e => (
        <article className="sheet letter" key={e.id}>
          <div className="lh"><div><b style={{ fontSize: 18, fontWeight: 400 }}>{project.firm.name || project.name}</b><div style={{ color: '#5d5d5d' }}>{project.firm.address}</div></div><div>{today}</div></div>
          {project.sampleId && <p style={{ color: '#b42318', fontWeight: 600 }}>SYNTHETIC SAMPLE: invented client</p>}
          {fill(e).split(/\n{2,}/).map((para, i) => <p key={i} style={{ whiteSpace: 'pre-line' }}>{para}</p>)}
        </article>
      ))}
    </div>
  )
}
