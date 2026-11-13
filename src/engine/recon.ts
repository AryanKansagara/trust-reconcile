import { addMonths, dayNum, monthEnd, monthOf, monthStart, monthsBetween } from './dates.ts'
import { OPERATING } from './importer.ts'
import { matchItems, type Match } from './match.ts'
import type { BankLine, BookEntry, Cents, Config, Dataset, LedgerBalance } from './types.ts'

export type ExKind = 'negative' | 'uncleared' | 'transfer' | 'stale' | 'bankfee' | 'interest' | 'duplicate' | 'unrecorded' | 'stale-cheque' | 'old-deposit' | 'statement-gap' | 'unexplained' | 'ledger-mismatch'
export type Severity = 'critical' | 'warning' | 'info'

export interface Correction {
  date: string
  matter: string
  client: string
  type: 'Deposit' | 'Disbursement' | 'Reversal' | 'Bank charge' | 'Interest' | 'Transfer from operating'
  amount: Cents
  reference: string
  description: string
}

export interface Exception {
  id: string
  kind: ExKind
  severity: Severity
  title: string
  detail: string
  amount: Cents
  matter?: string
  client?: string
  date?: string
  bankIds: string[]
  bookIds: string[]
  fix: Correction[]
}

export interface ClientRow {
  matter: string
  client: string
  balance: Cents // the client ledger figure used in the tie-out
  derived: Cents // from the journal
  imported?: Cents // from the client ledger balances file
  lastActivity?: string
  minBalance: Cents // lowest running balance during the month
}

export interface MonthRecon {
  month: string
  start: string
  end: string
  statement: { opening: Cents; closing: Cents; source: 'file' | 'manual' | 'derived' | 'assumed' }
  bankLines: BankLine[]
  movement: Cents
  statementGap: Cents
  matches: Match[]
  outstandingDeposits: BookEntry[]
  outstandingCheques: BookEntry[]
  bankOnly: BankLine[]
  dit: Cents
  oc: Cents
  adjustedBank: Cents
  journal: Cents
  clients: ClientRow[]
  clientSource: 'imported' | 'derived'
  clientTotal: Cents
  unallocated: BookEntry[]
  unallocatedTotal: Cents
  ledgerDiffTotal: Cents
  bankOnlyTotal: Cents
  unexplainedBank: Cents
  unexplainedClients: Cents
  tiesOut: boolean
  exceptions: Exception[]
  /** Journal entries dated before the first statement that matched nothing; assumed cleared earlier. */
  assumedCleared: BookEntry[]
}

const FEE = /\b(fee|fees|charge|chg|svc|service charge|nsf|overdraft|maintenance)\b/i
const INTEREST = /interest|\bint\b|iolta int|dividend/i
const INVOICE = /\b(inv|invoice|bill|stmt)\b\.?\s*#?\s*[a-z]*-?\d+/i

export const sum = (xs: { amount: Cents }[]) => xs.reduce((a, x) => a + x.amount, 0)
export const bankMonths = (ds: Dataset) => [...new Set(ds.bank.map(b => monthOf(b.date)))].sort()

/** Reconciles every month that has bank lines, oldest first, carrying uncleared items forward. */
export function reconcileAll(ds: Dataset, cfg: Config): Map<string, MonthRecon> {
  const out = new Map<string, MonthRecon>()
  const months = bankMonths(ds)
  const cleared = new Map<string, string>() // book id -> bank date it cleared
  const bankDone = new Set<string>()
  const book = [...ds.book].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)
  let prevClosing: number | null = null
  for (const month of months) {
    const start = monthStart(month), end = monthEnd(month)
    const bankLines = ds.bank.filter(b => monthOf(b.date) === month)
    // Unmatched bank lines from the previous three months stay matchable.
    const carriedBank = ds.bank.filter(b => b.date < start && !bankDone.has(b.id) && monthsBetween(monthOf(b.date), month) <= 3)
    const candidates = book.filter(e => e.date <= end && !cleared.has(e.id) && e.kind !== 'opening')
    // Carried bank lines get the long window, since a late journal entry can trail them by weeks.
    const res = matchItems([...carriedBank, ...bankLines], candidates, cfg.settings, cfg.manual, cfg.rejected)
    const lateRes = res.bankOnly.some(b => b.date < start)
      ? matchItems(res.bankOnly.filter(b => b.date < start), res.bookOnly, { ...cfg.settings, dateWindow: 60 }, [], cfg.rejected)
      : null
    const matches = [...res.matches, ...(lateRes?.matches ?? [])]
    const bankById = new Map(ds.bank.map(b => [b.id, b]))
    for (const m of matches) {
      const d = m.bank.map(id => bankById.get(id)!.date).sort().at(-1)!
      for (const id of m.book) cleared.set(id, d)
      for (const id of m.bank) bankDone.add(id)
    }
    const matchedBook = new Set(matches.flatMap(m => m.book))
    const matchedBank = new Set(matches.flatMap(m => m.bank))
    // Before the first imported statement we cannot see the bank, so unmatched older entries are assumed cleared.
    const assumedCleared = month === months[0] ? candidates.filter(e => e.date < start && !matchedBook.has(e.id)) : []
    for (const e of assumedCleared) cleared.set(e.id, '0000-00-00')
    const bookOnly = candidates.filter(e => !matchedBook.has(e.id) && !assumedCleared.includes(e))
    const bankOnly = [...carriedBank, ...bankLines].filter(b => !matchedBank.has(b.id))

    const movement = sum(bankLines)
    const journalBefore = sum(book.filter(e => e.date < start))
    const outstandingBefore = sum(book.filter(e => e.date < start && e.kind !== 'opening' && (!cleared.has(e.id) || cleared.get(e.id)! >= start)))
    let statement: MonthRecon['statement']
    const given = cfg.statements[month]
    if (given) statement = { ...given }
    else if (prevClosing !== null) statement = { opening: prevClosing, closing: prevClosing + movement, source: 'derived' }
    else {
      // Nothing to go on: assume the opening bank balance agrees with the reconciled journal.
      const opening = journalBefore - outstandingBefore
      statement = { opening, closing: opening + movement, source: 'assumed' }
    }
    prevClosing = statement.closing
    const statementGap = statement.opening + movement - statement.closing

    const outstanding = bookOnly
    const outstandingDeposits = outstanding.filter(e => e.amount > 0)
    const outstandingCheques = outstanding.filter(e => e.amount < 0)
    const dit = sum(outstandingDeposits), oc = sum(outstandingCheques)
    const adjustedBank = statement.closing + dit + oc
    const upto = book.filter(e => e.date <= end)
    const journal = sum(upto)
    const unallocated = upto.filter(e => !e.matter)
    const unallocatedTotal = sum(unallocated)

    const clients = clientRows(upto, ds.balances, month)
    const clientSource: MonthRecon['clientSource'] = clients.some(c => c.imported !== undefined) ? 'imported' : 'derived'
    const clientTotal = clients.reduce((a, c) => a + c.balance, 0)
    const ledgerDiffTotal = clients.reduce((a, c) => a + (c.derived - c.balance), 0)
    const bankOnlyTotal = sum(bankOnly)
    const unexplainedBank = adjustedBank - journal - bankOnlyTotal
    const unexplainedClients = journal - clientTotal - unallocatedTotal - ledgerDiffTotal

    const r: MonthRecon = {
      month, start, end, statement, bankLines, movement, statementGap, matches, outstandingDeposits, outstandingCheques, bankOnly,
      dit, oc, adjustedBank, journal, clients, clientSource, clientTotal, unallocated, unallocatedTotal, ledgerDiffTotal,
      bankOnlyTotal, unexplainedBank, unexplainedClients, tiesOut: adjustedBank === journal && journal === clientTotal, exceptions: [], assumedCleared,
    }
    r.exceptions = findExceptions(r, book, ds, cfg, cleared)
    out.set(month, r)
  }
  return out
}

/** Per-matter balances: derived from the journal, compared with the imported client ledger balances when present. */
export function clientRows(upto: BookEntry[], balances: LedgerBalance[], month: string): ClientRow[] {
  const start = monthStart(month)
  const byMatter = new Map<string, { client: string; derived: number; last?: string; run: number; min: number; started: boolean }>()
  // Deposits before disbursements on the same day, as the bank would see them.
  const ordered = [...upto].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  for (const e of ordered) {
    if (!e.matter) continue
    const m = byMatter.get(e.matter) ?? { client: e.client, derived: 0, run: 0, min: Infinity, started: false }
    if (!m.client && e.client) m.client = e.client
    if (e.date >= start && !m.started) { m.min = Math.min(m.min, m.run); m.started = true }
    m.run += e.amount
    m.derived += e.amount
    if (e.date >= start) m.min = Math.min(m.min, m.run)
    if (e.kind !== 'opening') m.last = !m.last || e.date > m.last ? e.date : m.last
    byMatter.set(e.matter, m)
  }
  // Use the latest balances file dated inside this month.
  const asOfs = [...new Set(balances.filter(b => monthOf(b.asOf) === month).map(b => b.asOf))].sort()
  const imp = asOfs.length ? balances.filter(b => b.asOf === asOfs.at(-1)) : []
  const rows = new Map<string, ClientRow>()
  for (const [matter, m] of byMatter) rows.set(matter, { matter, client: m.client, derived: m.derived, balance: m.derived, lastActivity: m.last, minBalance: m.min === Infinity ? m.run : m.min })
  if (imp.length) {
    for (const r of rows.values()) { r.imported = 0; r.balance = 0 }
    for (const b of imp) {
      const r = rows.get(b.matter) ?? { matter: b.matter, client: b.client, derived: 0, balance: 0, minBalance: b.balance }
      r.imported = (r.imported ?? 0) + b.balance
      r.balance = r.imported
      if (!r.client) r.client = b.client
      if (b.lastActivity && (!r.lastActivity || b.lastActivity > r.lastActivity)) r.lastActivity = b.lastActivity
      rows.set(b.matter, r)
    }
  }
  return [...rows.values()].filter(r => r.balance !== 0 || r.derived !== 0 || r.minBalance < 0).sort((a, b) => a.matter.localeCompare(b.matter))
}

function findExceptions(r: MonthRecon, book: BookEntry[], ds: Dataset, cfg: Config, cleared: Map<string, string>): Exception[] {
  const ex: Exception[] = []
  const s = cfg.settings
  const inMonth = (d: string) => d >= r.start && d <= r.end
  const matters = new Map(r.clients.map(c => [c.matter, c]))
  // Best client for a free-text description: the matter number, or distinctive words of the client name.
  const STOP = new Set(['estate', 'estates', 'the', 'and', 'trust', 'family', 'law', 'inc', 'llc', 'ltd', 'corp', 'fees', 'operating'])
  const words = (t: string) => t.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean)
  const guessMatter = (text: string) => {
    const tw = new Set(words(text))
    let best: ClientRow | undefined, bestScore = 0
    for (const c of matters.values()) {
      let score = text.toLowerCase().includes(c.matter.toLowerCase()) ? 10 : 0
      for (const w of words(c.client)) if (w.length > 3 && !STOP.has(w) && tw.has(w)) score++
      if (score > bestScore) { best = c; bestScore = score }
    }
    return best
  }
  const fmt = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`

  if (r.statementGap !== 0) ex.push({
    id: `statement-gap:${r.month}`, kind: 'statement-gap', severity: 'critical', amount: -r.statementGap, date: r.end, bankIds: [], bookIds: [], fix: [],
    title: 'Statement lines do not add up to the closing balance',
    detail: `Opening ${fmt(r.statement.opening)} plus this month's lines (${fmt(r.movement)}) gives ${fmt(r.statement.opening + r.movement)}, but the statement closes at ${fmt(r.statement.closing)}. A page or some lines are missing from the export.`,
  })

  // Negative client balances and disbursements against uncleared deposits.
  for (const c of r.clients) {
    if (c.minBalance < 0 || c.balance < 0) {
      const low = Math.min(c.minBalance, c.balance)
      const entries = book.filter(e => e.matter === c.matter && inMonth(e.date) && e.amount < 0)
      ex.push({
        id: `negative:${c.matter}:${r.month}`, kind: 'negative', severity: 'critical', amount: low, matter: c.matter, client: c.client, date: r.end, bankIds: [], bookIds: entries.map(e => e.id),
        title: `Negative client balance: ${c.matter}`,
        detail: `The ledger for ${c.client || c.matter} went to ${fmt(low)}${c.balance < 0 ? ' and ends the month negative' : ''}. Money belonging to other clients was used for this matter, which bar and law society auditors treat as a serious breach. Replace the shortfall from firm funds now and find the entry that caused it.`,
        fix: [{ date: r.end, matter: c.matter, client: c.client, type: 'Transfer from operating', amount: -low, reference: 'FIRM-FUNDS', description: `Replenish trust shortfall on ${c.matter} from operating` }],
      })
    }
  }
  const byMatter = new Map<string, BookEntry[]>()
  for (const e of book) if (e.matter && e.date <= r.end) byMatter.set(e.matter, [...(byMatter.get(e.matter) ?? []), e])
  for (const [matter, es] of byMatter) {
    // Deposits count from the day the bank cleared them; money out counts from the journal date.
    const events = es.filter(e => e.kind !== 'opening' || e.amount < 0).map(e => ({ e, at: e.amount > 0 ? (cleared.get(e.id) && cleared.get(e.id)! <= r.end ? cleared.get(e.id)! : '9999') : e.date }))
    const opening = es.filter(e => e.kind === 'opening' && e.amount > 0).reduce((a, e) => a + e.amount, 0)
    events.sort((a, b) => a.at.localeCompare(b.at) || b.e.amount - a.e.amount)
    let clearedBal = opening, bookBal = opening
    const bookEvents = [...es].filter(e => e.kind !== 'opening').sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
    let worst: { at: string; bal: number; e: BookEntry } | null = null
    for (const ev of events) {
      if (ev.at === '9999') continue
      clearedBal += ev.e.amount
      if (ev.e.amount < 0 && inMonth(ev.at) && clearedBal < 0) {
        bookBal = opening + bookEvents.filter(x => x.date <= ev.at).reduce((a, x) => a + x.amount, 0)
        if (bookBal >= 0 && (!worst || clearedBal < worst.bal)) worst = { at: ev.at, bal: clearedBal, e: ev.e }
      }
    }
    if (worst) {
      const c = matters.get(matter)
      const pending = es.filter(e => e.amount > 0 && e.date <= worst!.at && (!cleared.get(e.id) || cleared.get(e.id)! > worst!.at))
      ex.push({
        id: `uncleared:${worst.e.id}`, kind: 'uncleared', severity: 'warning', amount: worst.bal, matter, client: c?.client, date: worst.at, bankIds: [], bookIds: [worst.e.id, ...pending.map(p => p.id)], fix: [],
        title: `Paid out before the deposit cleared: ${matter}`,
        detail: `${worst.e.desc || worst.e.payee || 'A payment'} (${fmt(worst.e.amount)}) on ${worst.at} was made while ${pending.length ? `the deposit of ${fmt(sum(pending))} from ${pending[0].date}` : 'a deposit'} had not cleared the bank. For that period the payment was funded with other clients' money (${fmt(worst.bal)} short). Wait for deposits to clear before disbursing.`,
      })
    }
  }

  // Transfers to operating: the Transfer vs Disburse mistake.
  for (const e of book.filter(e => inMonth(e.date) && e.amount < 0 && (e.kind === 'transfer' || OPERATING.test(`${e.desc} ${e.payee}`)))) {
    const hasInvoice = INVOICE.test(`${e.ref} ${e.desc}`)
    if (e.matter && hasInvoice) continue
    const guess = e.matter ? matters.get(e.matter) : guessMatter(`${e.desc} ${e.ref}`)
    const target = guess?.matter ?? 'ASSIGN-MATTER'
    ex.push({
      id: `transfer:${e.id}`, kind: 'transfer', severity: e.matter ? 'warning' : 'critical', amount: e.amount, matter: e.matter || guess?.matter, client: e.client || guess?.client, date: e.date, bankIds: [], bookIds: [e.id],
      title: e.matter ? `Transfer to operating with no invoice: ${e.matter}` : 'Transfer to operating not charged to any client',
      detail: e.matter
        ? `${fmt(-e.amount)} moved to operating on ${e.date} without an invoice reference. Earned fees should leave trust as a disbursement against a specific bill so the client and the auditor can trace it.`
        : `${fmt(-e.amount)} moved to operating on ${e.date} as an account transfer, so no client ledger was reduced. This is the "Transfer Funds instead of Disburse Funds" mistake: the client ledgers now claim more money than the account holds. Re-record it as a disbursement against the matter and invoice it paid${guess ? ` (looks like ${guess.matter})` : ''}.`,
      fix: [
        { date: e.date, matter: e.matter, client: e.client, type: 'Reversal', amount: -e.amount, reference: e.ref, description: `Reverse account transfer: ${e.desc || 'transfer to operating'}` },
        { date: e.date, matter: target, client: guess?.client ?? e.client, type: 'Disbursement', amount: e.amount, reference: 'INV-____', description: `Earned fees to operating, invoice INV-____ (was recorded as a transfer)` },
      ],
    })
  }

  // Bank-only lines: unrecorded withdrawals, deposits, fees and interest.
  for (const b of r.bankOnly) {
    const text = `${b.desc} ${b.ref}`
    const age = dayNum(r.end) - dayNum(b.date)
    const carried = b.date < r.start ? ` It has been on the statement since ${b.date} (${age} days).` : ''
    if (b.amount < 0 && OPERATING.test(text) && !FEE.test(text)) {
      const guess = guessMatter(text)
      ex.push({
        id: `transfer:${b.id}`, kind: 'transfer', severity: 'critical', amount: b.amount, matter: guess?.matter, client: guess?.client, date: b.date, bankIds: [b.id], bookIds: [],
        title: 'Money moved to operating with no journal entry',
        detail: `The bank shows ${fmt(-b.amount)} leaving trust for the firm's account ("${b.desc}"), but nothing in the trust journal or any client ledger records it. Record it as a disbursement of earned fees against the matter and invoice it paid.${carried}`,
        fix: [{ date: b.date, matter: guess?.matter ?? 'ASSIGN-MATTER', client: guess?.client ?? '', type: 'Disbursement', amount: b.amount, reference: 'INV-____', description: `Earned fees to operating (${b.desc})` }],
      })
    } else if (b.amount < 0 && FEE.test(text)) {
      ex.push({
        id: `bankfee:${b.id}`, kind: 'bankfee', severity: 'warning', amount: b.amount, date: b.date, bankIds: [b.id], bookIds: [],
        title: 'Bank fee charged to the trust account',
        detail: `"${b.desc}" (${fmt(b.amount)}) was taken from trust. Fees can't come out of client money: deposit firm funds to cover it, record both entries, and ask the bank to charge fees to the operating account.${carried}`,
        fix: [
          { date: b.date, matter: 'FIRM-BANK-CHARGES', client: 'Firm', type: 'Transfer from operating', amount: -b.amount, reference: 'FIRM-FUNDS', description: 'Firm funds to cover bank charge' },
          { date: b.date, matter: 'FIRM-BANK-CHARGES', client: 'Firm', type: 'Bank charge', amount: b.amount, reference: b.ref, description: b.desc },
        ],
      })
    } else if (b.amount > 0 && INTEREST.test(text)) {
      ex.push({
        id: `interest:${b.id}`, kind: 'interest', severity: 'info', amount: b.amount, date: b.date, bankIds: [b.id], bookIds: [],
        title: 'Interest credited to the trust account',
        detail: `${fmt(b.amount)} of interest landed in trust. On a pooled IOLTA or general trust account the interest belongs to the state IOLTA program or the provincial law foundation, not the firm or a client. Record it and remit it unless your bank remits directly.${carried}`,
        fix: [
          { date: b.date, matter: 'IOLTA-INTEREST', client: 'Interest program', type: 'Interest', amount: b.amount, reference: b.ref, description: b.desc },
          { date: b.date, matter: 'IOLTA-INTEREST', client: 'Interest program', type: 'Disbursement', amount: -b.amount, reference: 'REMIT', description: 'Remit trust interest to the interest program' },
        ],
      })
    } else {
      const guess = guessMatter(text)
      ex.push({
        id: `unrecorded:${b.id}`, kind: 'unrecorded', severity: b.amount < 0 ? 'critical' : 'warning', amount: b.amount, matter: guess?.matter, client: guess?.client, date: b.date, bankIds: [b.id], bookIds: [],
        title: b.amount < 0 ? 'Withdrawal on the statement, not in the journal' : 'Deposit on the statement, not in the journal',
        detail: `${b.date} "${b.desc}"${b.ref ? ` #${b.ref}` : ''} for ${fmt(b.amount)} has no matching journal entry. ${b.amount < 0 ? 'Find who authorised it and which client it was for.' : 'Identify the client and record the receipt.'}${carried}`,
        fix: [{ date: b.date, matter: guess?.matter ?? 'ASSIGN-MATTER', client: guess?.client ?? '', type: b.amount < 0 ? 'Disbursement' : 'Deposit', amount: b.amount, reference: b.ref, description: b.desc }],
      })
    }
  }

  // Fees or interest posted in the journal to a client ledger.
  for (const e of book.filter(e => inMonth(e.date) && (e.kind === 'fee' || e.kind === 'interest') && e.matter && !/^(firm|iolta)/i.test(e.matter))) {
    ex.push({
      id: `${e.kind === 'fee' ? 'bankfee' : 'interest'}:${e.id}`, kind: e.kind === 'fee' ? 'bankfee' : 'interest', severity: 'warning', amount: e.amount, matter: e.matter, client: e.client, date: e.date, bankIds: [], bookIds: [e.id],
      title: e.kind === 'fee' ? `Bank fee charged to a client ledger: ${e.matter}` : `Bank interest credited to a client ledger: ${e.matter}`,
      detail: e.kind === 'fee' ? `${fmt(e.amount)} "${e.desc}" was posted to ${e.client || e.matter}. Bank charges are a firm expense; reverse it from the client and cover it with firm funds.` : `${fmt(e.amount)} of pooled-account interest was posted to ${e.client || e.matter}. Pooled interest usually belongs to the interest program; check whether this matter has its own interest-bearing trust account.`,
      fix: [{ date: e.date, matter: e.matter, client: e.client, type: 'Reversal', amount: -e.amount, reference: e.ref, description: `Reverse ${e.kind === 'fee' ? 'bank charge' : 'interest'} posted to client` }],
    })
  }

  // Duplicates in the journal.
  const groups = new Map<string, BookEntry[]>()
  for (const e of book.filter(e => inMonth(e.date) && e.kind !== 'opening')) {
    const k = e.ref ? `${e.matter}|${e.amount}|r${e.ref}` : `${e.matter}|${e.amount}|${e.date}|${e.desc.toLowerCase()}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  for (const g of groups.values()) if (g.length > 1) {
    const [first, ...extra] = g
    ex.push({
      id: `duplicate:${g.map(e => e.id).join('+')}`, kind: 'duplicate', severity: 'warning', amount: sum(extra), matter: first.matter, client: first.client, date: first.date, bankIds: [], bookIds: g.map(e => e.id),
      title: `Possible duplicate journal entry${first.matter ? `: ${first.matter}` : ''}`,
      detail: `${g.length} entries for ${fmt(first.amount)}${first.ref ? ` with reference ${first.ref}` : ` on ${first.date}`} ("${first.desc}"), lines ${g.map(e => e.line).join(', ')}. If it was recorded twice, reverse the extra ${extra.length === 1 ? 'entry' : 'entries'}.`,
      fix: extra.map(e => ({ date: e.date, matter: e.matter, client: e.client, type: 'Reversal' as const, amount: -e.amount, reference: e.ref, description: `Reverse duplicate of line ${first.line}: ${e.desc}` })),
    })
  }
  const bgroups = new Map<string, BankLine[]>()
  for (const b of r.bankLines) { const k = `${b.date}|${b.amount}|${b.ref}|${b.desc.toLowerCase()}`; bgroups.set(k, [...(bgroups.get(k) ?? []), b]) }
  for (const g of bgroups.values()) if (g.length > 1) ex.push({
    id: `duplicate:${g.map(b => b.id).join('+')}`, kind: 'duplicate', severity: 'info', amount: g[0].amount, date: g[0].date, bankIds: g.map(b => b.id), bookIds: [], fix: [],
    title: 'Identical bank lines',
    detail: `${g.length} lines on ${g[0].date} for ${fmt(g[0].amount)} ("${g[0].desc}"). Often legitimate (two equal deposits), but check the export did not repeat a page.`,
  })

  // Stale balances.
  const cutoff = addMonths(r.month, -s.staleMonths)
  for (const c of r.clients) if (c.balance > 0 && c.lastActivity && monthOf(c.lastActivity) <= cutoff) {
    const months = monthsBetween(monthOf(c.lastActivity), r.month)
    ex.push({
      id: `stale:${c.matter}`, kind: 'stale', severity: 'info', amount: c.balance, matter: c.matter, client: c.client, date: c.lastActivity, bankIds: [], bookIds: [], fix: [],
      title: `Dormant balance: ${c.matter}`,
      detail: `${fmt(c.balance)} has sat in trust for ${c.client || c.matter} with no activity for ${months} months (last on ${c.lastActivity}). Write to the client to return it or confirm instructions; unclaimed funds eventually go to the state or law society unclaimed trust fund program.`,
    })
  }

  // Outstanding items that are getting old.
  for (const e of r.outstandingCheques) {
    const age = dayNum(r.end) - dayNum(e.date)
    if (age < s.staleChequeDays) continue
    ex.push({
      id: `stale-cheque:${e.id}`, kind: 'stale-cheque', severity: 'warning', amount: e.amount, matter: e.matter, client: e.client, date: e.date, bankIds: [], bookIds: [e.id],
      title: `Stale-dated cheque${e.ref ? ` #${e.ref}` : ''}`,
      detail: `${fmt(e.amount)} to ${e.payee || e.desc || 'payee'} has been outstanding ${age} days. Contact the payee; if it will not be cashed, void it and return the money to the client ledger.`,
      fix: [{ date: r.end, matter: e.matter, client: e.client, type: 'Reversal', amount: -e.amount, reference: e.ref, description: `Void stale-dated cheque ${e.ref}` }],
    })
  }
  const dupIds = new Set(ex.filter(x => x.kind === 'duplicate').flatMap(x => x.bookIds))
  for (const e of r.outstandingDeposits) {
    const age = dayNum(r.end) - dayNum(e.date)
    if (age <= 10 || dupIds.has(e.id)) continue
    ex.push({
      id: `old-deposit:${e.id}`, kind: 'old-deposit', severity: 'warning', amount: e.amount, matter: e.matter, client: e.client, date: e.date, bankIds: [], bookIds: [e.id], fix: [],
      title: `Deposit in transit for ${age} days`,
      detail: `${fmt(e.amount)} recorded on ${e.date} for ${e.client || e.matter || 'no matter'} has not reached the bank. Deposits normally clear within a week or two; confirm it was actually deposited.`,
    })
  }

  for (const c of r.clients) if (c.imported !== undefined && c.imported !== c.derived) ex.push({
    id: `ledger-mismatch:${c.matter}:${r.month}`, kind: 'ledger-mismatch', severity: 'warning', amount: c.derived - c.imported, matter: c.matter, client: c.client, date: r.end, bankIds: [], bookIds: [], fix: [],
    title: `Client ledger disagrees with the journal: ${c.matter}`,
    detail: `The client ledger report says ${fmt(c.imported)}; the journal entries for this matter add up to ${fmt(c.derived)}. One of the two exports is missing entries or was run for a different date.`,
  })

  if (r.unexplainedBank !== 0 || r.unexplainedClients !== 0) ex.push({
    id: `unexplained:${r.month}`, kind: 'unexplained', severity: 'critical', amount: r.unexplainedBank || r.unexplainedClients, date: r.end, bankIds: [], bookIds: [], fix: [],
    title: 'Difference with no identified cause',
    detail: [
      r.unexplainedBank ? `Bank vs journal: ${fmt(r.unexplainedBank)} not explained by outstanding or unrecorded items. Usually the opening balances disagree (an earlier month never reconciled) or the journal export starts after the oldest outstanding item.` : '',
      r.unexplainedClients ? `Journal vs client ledgers: ${fmt(r.unexplainedClients)} not explained.` : '',
    ].filter(Boolean).join(' '),
  })

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }
  return ex.sort((a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.amount) - Math.abs(a.amount))
}

export const CORRECTION_HEADER = ['date', 'matter', 'client', 'type', 'amount', 'funds_in', 'funds_out', 'reference', 'description', 'reason']

/** Suggested correcting entries for the month as CSV rows (amounts in dollars). */
export function correctionRows(r: MonthRecon, only?: Set<string>): (string | number)[][] {
  const rows: (string | number)[][] = [CORRECTION_HEADER]
  for (const e of r.exceptions) {
    if (only && !only.has(e.id)) continue
    for (const f of e.fix) rows.push([f.date, f.matter, f.client, f.type, (f.amount / 100).toFixed(2), f.amount > 0 ? (f.amount / 100).toFixed(2) : '', f.amount < 0 ? (-f.amount / 100).toFixed(2) : '', f.reference, f.description, e.title])
  }
  return rows
}

export const EX_LABEL: Record<ExKind, string> = {
  negative: 'Negative client balance',
  uncleared: 'Paid before deposit cleared',
  transfer: 'Transfer to operating',
  stale: 'Dormant balance',
  bankfee: 'Bank fee in trust',
  interest: 'Interest in trust',
  duplicate: 'Possible duplicate',
  unrecorded: 'Not in the journal',
  'stale-cheque': 'Stale-dated cheque',
  'old-deposit': 'Old deposit in transit',
  'statement-gap': 'Statement gap',
  unexplained: 'Unexplained difference',
  'ledger-mismatch': 'Ledger mismatch',
}
