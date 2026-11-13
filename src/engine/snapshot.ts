import type { Project, Signoff, Snapshot } from '../store.ts'
import type { MonthRecon } from './recon.ts'
import type { Config } from './types.ts'

/** Freezes a month's reconciliation into the record kept for history, compare and the calendar. */
export function makeSnapshot(r: MonthRecon, id: string, currency: Config['currency'], signoff?: Signoff): Snapshot {
  return {
    id, month: r.month, createdAt: Date.now(), currency, tiesOut: r.tiesOut,
    totals: { closing: r.statement.closing, dit: r.dit, oc: r.oc, adjustedBank: r.adjustedBank, journal: r.journal, clientTotal: r.clientTotal, bankOnly: r.bankOnlyTotal, unallocated: r.unallocatedTotal, unexplainedBank: r.unexplainedBank, unexplainedClients: r.unexplainedClients },
    counts: {
      matched: r.matches.length, outstanding: r.outstandingDeposits.length + r.outstandingCheques.length, bankOnly: r.bankOnly.length,
      critical: r.exceptions.filter(e => e.severity === 'critical').length, warning: r.exceptions.filter(e => e.severity === 'warning').length, info: r.exceptions.filter(e => e.severity === 'info').length,
    },
    exceptions: r.exceptions.map(e => ({ id: e.id, kind: e.kind, severity: e.severity, amount: e.amount, title: e.title, matter: e.matter })),
    outstanding: [...r.outstandingDeposits, ...r.outstandingCheques].map(e => ({ id: e.id, date: e.date, amount: e.amount, ref: e.ref, matter: e.matter, payee: e.payee })),
    clients: r.clients.map(c => ({ matter: c.matter, client: c.client, balance: c.balance })),
    ...(signoff ? { signoff } : {}),
  }
}

/** What a snapshot looks like in the cloud. Totals-only drops every client name, matter number and payee. */
export function cloudSnapshot(s: Snapshot, totalsOnly: boolean): Snapshot {
  if (!totalsOnly) return s
  const { clients: _c, ...rest } = s
  return {
    ...rest,
    exceptions: s.exceptions.map((e, i) => ({ id: `${e.kind}-${i}`, kind: e.kind, severity: e.severity, amount: e.amount })),
    outstanding: s.outstanding.map((o, i) => ({ id: `o-${i}`, date: o.date, amount: o.amount, ref: /^\d+$/.test(o.ref) ? o.ref : '' })),
  }
}

/** The project row as stored in the cloud. Totals-only also drops file names, which often contain client names. */
export function cloudProject(p: Project, totalsOnly: boolean): Omit<Project, 'snapshots' | 'dataMissing'> {
  const { snapshots: _s, dataMissing: _m, ...meta } = p
  return totalsOnly ? { ...meta, imports: meta.imports.map(i => ({ ...i, fileName: `${i.kind} file` })) } : meta
}

export interface CalendarCell { month: string; status: 'signed' | 'reviewed' | 'reconciled' | 'data' | 'none'; due: string; overdue: boolean; snapshot?: Snapshot }

/** Due date after month end: Ontario By-Law 9 s.22 allows 25 days, BC Rule 3-73(5) 30 days; elsewhere the end of the next month (firm policy). */
export function dueDate(month: string, jurisdiction: Config['jurisdiction']): string {
  const [y, m] = month.split('-').map(Number)
  const end = Date.UTC(y, m, 0)
  const days = { on: 25, bc: 30 }[jurisdiction as 'on' | 'bc']
  if (days) return new Date(end + days * 86400000).toISOString().slice(0, 10)
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10)
}

/** Twelve months ending at `last`: which are reconciled, signed, or overdue as of `today`. */
export function complianceCalendar(last: string, snapshots: Snapshot[], dataMonths: string[], jurisdiction: Config['jurisdiction'], today: string): CalendarCell[] {
  const out: CalendarCell[] = []
  const [y, m] = last.split('-').map(Number)
  for (let i = 11; i >= 0; i--) {
    const month = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7)
    const snap = snapshots.find(s => s.month === month)
    const status: CalendarCell['status'] = snap?.signoff?.reviewer ? 'reviewed' : snap?.signoff ? 'signed' : snap ? 'reconciled' : dataMonths.includes(month) ? 'data' : 'none'
    const due = dueDate(month, jurisdiction)
    out.push({ month, status, due, overdue: today > due && status !== 'signed' && status !== 'reviewed' && status !== 'none', snapshot: snap })
  }
  return out
}
