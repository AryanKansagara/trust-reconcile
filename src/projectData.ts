import { useEffect, useMemo, useState } from 'react'
import { reconcileAll, type MonthRecon } from './engine/recon.ts'
import { SAMPLES, generate, sampleConfig } from './engine/sample.ts'
import { makeSnapshot } from './engine/snapshot.ts'
import { EMPTY_DATASET, type Config, type Dataset } from './engine/types.ts'
import { blankConfig, blankFirm, getData, getProjects, saveProject, useProjects, uuid, type Project } from './store.ts'
import { setCurrency } from './ui.tsx'

const sampleCache = new Map<string, Dataset>()
export function sampleDataset(id: string): Dataset | null {
  const def = SAMPLES.find(s => s.id === id)
  if (!def) return null
  if (!sampleCache.has(id)) sampleCache.set(id, generate(def))
  return sampleCache.get(id)!
}

const STAFF: Record<string, [string, string]> = { marlowe: ['J. Kaur (bookkeeper)', 'E. Marlowe, Licensee'], reyes: ['T. Nakamura (paralegal)', 'A. Reyes, Esq.'] }

export async function createSampleProject(sampleId: string): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === sampleId)
  if (existing) return existing
  const def = SAMPLES.find(s => s.id === sampleId)!
  const ds = sampleDataset(sampleId)!
  const config = sampleConfig(def, ds)
  const recs = reconcileAll(ds, config)
  const [reconciler, reviewer] = STAFF[sampleId]
  // Earlier months are already closed (and mostly signed) so history, compare and the calendar have something to show.
  const months = [...recs.keys()].slice(0, -1)
  const snapshots = months.map(m => {
    const r = recs.get(m)!
    const signedOn = new Date(Date.parse(r.end) + 12 * 86400000).toISOString().slice(0, 10)
    const signed = !def.unsigned.includes(m)
    return makeSnapshot(r, uuid(), def.currency, signed ? { reconciler, reconciledAt: signedOn, reviewer, reviewedAt: signedOn } : undefined)
  })
  const now = Date.now()
  return saveProject({
    id: uuid(), name: def.name, createdAt: now, updatedAt: now, config, snapshots, sampleId,
    firm: { name: def.name, address: def.location, reconciler, reviewer, signatory: reviewer },
    imports: [
      { id: uuid(), kind: 'bank', fileName: `synthetic ${def.bankName} statement`, format: 'Synthetic', rows: ds.bank.length, skipped: 0, at: now },
      { id: uuid(), kind: 'book', fileName: 'synthetic trust ledger report', format: 'Synthetic', rows: ds.book.length, skipped: 0, at: now },
      { id: uuid(), kind: 'balances', fileName: 'synthetic trust listing report', format: 'Synthetic', rows: ds.balances.length, skipped: 0, at: now },
    ],
  })
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, config: blankConfig(), snapshots: [], imports: [], firm: blankFirm() })
}

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const [version, setVersion] = useState(0)
  const importsKey = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    if (project.sampleId) { setDs(sampleDataset(project.sampleId) ?? EMPTY_DATASET); return }
    void getData(project.id).then(d => { if (live) setDs(d ?? EMPTY_DATASET) })
    return () => { live = false }
  }, [project?.id, project?.sampleId, importsKey, version])
  if (project) setCurrency(project.config.currency)
  const update = (patch: Partial<Project>) => project && saveProject({ ...project, ...patch })
  const setConfig = (patch: Partial<Config>) => project && saveProject({ ...project, config: { ...project.config, ...patch } })
  return { loading: list === null || (project !== null && ds === null), project, ds, update, setConfig, reload: () => setVersion(v => v + 1) }
}

export function useRecons(ds: Dataset | null, cfg: Config | undefined) {
  return useMemo(() => ds && cfg && ds.bank.length ? reconcileAll(ds, cfg) : new Map<string, MonthRecon>(), [ds, cfg])
}

/** The month to open: from the URL, else the latest month with bank data. */
export function pickMonth(recs: Map<string, MonthRecon>): string | null {
  const q = new URLSearchParams(location.search).get('m')
  if (q && recs.has(q)) return q
  return [...recs.keys()].at(-1) ?? null
}

export const JURISDICTIONS: Record<Config['jurisdiction'], { label: string; short: string; rule: string }> = {
  aba: { label: 'ABA Model Rule 1.15 (generic US)', short: 'ABA Model Rule 1.15', rule: 'ABA Model Rule 1.15 and the Model Rules for Client Trust Account Records' },
  az: { label: 'Arizona', short: 'Arizona', rule: 'Arizona ER 1.15 and Supreme Court Rule 43' },
  ca: { label: 'California', short: 'California', rule: 'California Rule of Professional Conduct 1.15 and the State Bar trust accounting standards' },
  fl: { label: 'Florida', short: 'Florida', rule: 'Rules Regulating The Florida Bar, Chapter 5 (Rule 5-1.2)' },
  on: { label: 'Ontario (Law Society of Ontario)', short: 'Ontario', rule: 'Law Society of Ontario By-Law 9 (monthly trust comparison)' },
  bc: { label: 'British Columbia (Law Society of BC)', short: 'British Columbia', rule: 'Law Society of British Columbia Rule 3-73 (monthly trust reconciliation)' },
}
