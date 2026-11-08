import { useSyncExternalStore } from 'react'
import type { Kind } from './engine/importer.ts'
import type { ExKind, Severity } from './engine/recon.ts'
import { DEFAULT_SETTINGS, type Config, type Dataset, type Jurisdiction, type MatchSettings } from './engine/types.ts'

export interface ImportMeta { id: string; kind: Kind; fileName: string; format: string; rows: number; skipped: number; at: number }

export interface Signoff { reconciler: string; reconciledAt: string; reviewer?: string; reviewedAt?: string }

/** A closed month: totals always, client detail only on this device when "totals only" sync is on. */
export interface Snapshot {
  id: string
  month: string
  createdAt: number
  currency: Config['currency']
  tiesOut: boolean
  totals: { closing: number; dit: number; oc: number; adjustedBank: number; journal: number; clientTotal: number; bankOnly: number; unallocated: number; unexplainedBank: number; unexplainedClients: number }
  counts: { matched: number; outstanding: number; bankOnly: number; critical: number; warning: number; info: number }
  exceptions: { id: string; kind: ExKind; severity: Severity; amount: number; title?: string; matter?: string }[]
  outstanding: { id: string; date: string; amount: number; ref: string; matter?: string; payee?: string }[]
  clients?: { matter: string; client: string; balance: number }[]
  signoff?: Signoff
}

export interface Firm { name: string; address: string; reconciler: string; reviewer: string; signatory: string }

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  config: Config
  snapshots: Snapshot[]
  imports: ImportMeta[]
  firm: Firm
  sampleId?: string
  /** True when this device has no copy of the raw data (synced from another device). */
  dataMissing?: boolean
}

// ---------- Tiny IndexedDB wrapper (falls back to memory in private modes) ----------

const DB = 'trust-reconcile'
let dbp: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  return dbp ??= new Promise(res => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('projects', { keyPath: 'id' })
        req.result.createObjectStore('data')
      }
      req.onsuccess = () => res(req.result)
      req.onerror = () => res(null)
    } catch { res(null) }
  })
}
const mem = { projects: new Map<string, unknown>(), data: new Map<string, unknown>() }

async function tx<T>(store: 'projects' | 'data', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  if (!d) throw new Error('no-idb')
  return new Promise((res, rej) => {
    const r = fn(d.transaction(store, mode).objectStore(store))
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbGetAll<T>(store: 'projects'): Promise<T[]> {
  try { return await tx(store, 'readonly', s => s.getAll()) as T[] } catch { return [...mem[store].values()] as T[] }
}
async function idbGet<T>(store: 'projects' | 'data', key: string): Promise<T | undefined> {
  try { return await tx(store, 'readonly', s => s.get(key)) as T | undefined } catch { return mem[store].get(key) as T | undefined }
}
async function idbPut(store: 'projects' | 'data', value: unknown, key?: string) {
  try { await tx(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key)) } catch { mem[store].set(key ?? (value as { id: string }).id, value) }
}
async function idbDel(store: 'projects' | 'data', key: string) {
  try { await tx(store, 'readwrite', s => s.delete(key)) } catch { mem[store].delete(key) }
}

// ---------- In-memory project list with subscribers ----------

let projects: Project[] = []
let loaded = false
const subs = new Set<() => void>()
const emit = () => { projects = [...projects]; subs.forEach(f => f()) }
const changeHooks = new Set<(p: Project) => void>()

export const onProjectChange = (f: (p: Project) => void) => { changeHooks.add(f); return () => changeHooks.delete(f) }

export async function loadProjects() {
  projects = (await idbGetAll<Project>('projects')).sort((a, b) => b.updatedAt - a.updatedAt)
  loaded = true
  emit()
}

export function useProjects() {
  return useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f) }, () => loaded ? projects : null)
}

export const getProjects = () => projects
export const getProject = (id: string) => projects.find(p => p.id === id)

export async function saveProject(p: Project, opts: { touch?: boolean; silent?: boolean } = {}) {
  const next = opts.touch === false ? p : { ...p, updatedAt: Date.now() }
  await idbPut('projects', next)
  const i = projects.findIndex(x => x.id === p.id)
  if (i >= 0) projects[i] = next
  else projects.unshift(next)
  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  emit()
  if (!opts.silent) changeHooks.forEach(f => f(next))
  return next
}

/** Deletes locally; returns an undo function that restores the project and its data. */
export async function deleteProject(id: string): Promise<() => Promise<void>> {
  const p = getProject(id)
  const data = await idbGet<Dataset>('data', id)
  projects = projects.filter(x => x.id !== id)
  emit()
  await idbDel('projects', id)
  await idbDel('data', id)
  addTombstone(id)
  return async () => {
    if (!p) return
    removeTombstone(id)
    if (data) await idbPut('data', data, id)
    await saveProject(p)
  }
}

export const getData = (id: string) => idbGet<Dataset>('data', id)
export const putData = (id: string, ds: Dataset) => idbPut('data', ds, id)

export const uuid = () => crypto.randomUUID()

// Tombstones keep a project deleted offline from coming back on the next sync.
const TOMB = 'trust-reconcile.tombstones'
export const tombstones = (): string[] => { try { return JSON.parse(localStorage.getItem(TOMB) ?? '[]') } catch { return [] } }
const addTombstone = (id: string) => localStorage.setItem(TOMB, JSON.stringify([...new Set([...tombstones(), id])]))
const removeTombstone = (id: string) => localStorage.setItem(TOMB, JSON.stringify(tombstones().filter(x => x !== id)))
export const clearTombstones = (ids: string[]) => localStorage.setItem(TOMB, JSON.stringify(tombstones().filter(x => !ids.includes(x))))

// ---------- App preferences (settings page) ----------

export interface Prefs {
  /** Sync only totals and counts, never client names, matter numbers or raw files. */
  totalsOnly: boolean
  jurisdiction: Jurisdiction
  currency: Config['currency']
  settings: MatchSettings
  firm: Firm
}
const PREF_KEY = 'trust-reconcile.prefs'
const BLANK_FIRM: Firm = { name: '', address: '', reconciler: '', reviewer: '', signatory: '' }
const DEFAULT_PREFS: Prefs = { totalsOnly: true, jurisdiction: 'aba', currency: 'USD', settings: { ...DEFAULT_SETTINGS }, firm: BLANK_FIRM }
let prefs: Prefs | null = null
const prefSubs = new Set<() => void>()
export function getPrefs(): Prefs {
  if (prefs) return prefs
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}')
    prefs = { ...DEFAULT_PREFS, ...raw, settings: { ...DEFAULT_SETTINGS, ...raw.settings }, firm: { ...BLANK_FIRM, ...raw.firm } }
  } catch { prefs = DEFAULT_PREFS }
  return prefs!
}
export function setPrefs(p: Partial<Prefs>) {
  prefs = { ...getPrefs(), ...p }
  localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
  prefSubs.forEach(f => f())
}
export const usePrefs = () => useSyncExternalStore(f => { prefSubs.add(f); return () => prefSubs.delete(f) }, getPrefs)

export function blankConfig(): Config {
  const p = getPrefs()
  return { statements: {}, settings: { ...p.settings }, manual: [], rejected: [], jurisdiction: p.jurisdiction, currency: p.currency, accountName: 'Trust account' }
}
export const blankFirm = (): Firm => ({ ...getPrefs().firm })
