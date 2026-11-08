// Synthetic firms. Every name, matter and amount here is invented.
import { addMonths, dayNum, fromDayNum, monthEnd } from './dates.ts'
import { assignBankIds, assignBookIds, statementsFromBalances, toCsv } from './importer.ts'
import type { BankLine, BookEntry, Config, Dataset, LedgerBalance } from './types.ts'
import { DEFAULT_SETTINGS } from './types.ts'

export interface SampleDef {
  id: string
  name: string
  blurb: string
  location: string
  jurisdiction: Config['jurisdiction']
  currency: Config['currency']
  bankName: string
  operating: string
  seed: number
  matters: [string, string][]
  /** Months reconciled and signed before the latest one. */
  unsigned: string[]
  /** Last activity reported for the dormant matter (it predates the sample). */
  dormantSince?: string
}

export const FIRST = '2026-05'
export const LAST = '2026-10'

export const SAMPLES: SampleDef[] = [
  {
    id: 'marlowe', name: 'Marlowe Family Law', location: 'Toronto, Ontario', jurisdiction: 'on', currency: 'CAD', bankName: 'Synthetic Chartered Bank', operating: 'GENERAL ACCT 00412-5567', seed: 7,
    blurb: 'Clean month. A batched deposit, a deposit in transit and an outstanding cheque, all explained. Ties out to the cent.',
    unsigned: [],
    matters: [['FL-2026-014', 'Okonkwo, Adaeze'], ['FL-2026-019', 'Brennan, Siobhan'], ['FL-2026-022', 'Tremblay, Luc'], ['FL-2026-027', 'Haddad, Rania'], ['FL-2026-031', 'Kowalczyk, Piotr'], ['FL-2026-036', 'Ng, Vivian'], ['FL-2026-040', 'Desrosiers, Amélie'], ['FL-2026-043', 'Sandhu, Harpreet'], ['FL-2025-088', 'Fitzgerald, Colm'], ['FL-2026-047', 'Abara, Chidi']],
  },
  {
    id: 'reyes', name: 'Reyes Injury & Estates', location: 'Phoenix, Arizona', jurisdiction: 'az', currency: 'USD', bankName: 'Synthetic Western Bank', operating: 'OPERATING ...4471', seed: 23,
    blurb: 'Problem month. Fees moved with Transfer instead of Disburse, a negative client ledger, an outstanding cheque, a bank fee and a duplicate.',
    unsigned: ['2026-08'], dormantSince: '2025-08-14',
    matters: [['PI-2026-031', 'Gutierrez, Marisol'], ['PI-2026-018', 'Begay, Tyrone'], ['PI-2026-024', 'Castillo, Ramon'], ['ES-2026-007', 'Estate of H. Lindqvist'], ['PI-2025-112', 'Whitfield, Dana'], ['ES-2024-118', 'Estate of R. Whitcombe'], ['PI-2026-040', 'Okafor, Emeka'], ['PI-2026-044', 'Duran, Lucia'], ['ES-2026-013', 'Estate of M. Abernathy']],
  },
]

function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const weekday = (d: number) => { const w = new Date(d * 86400000).getUTCDay(); return w === 0 ? d + 1 : w === 6 ? d + 2 : d }

export function generate(def: SampleDef): Dataset {
  const r = rng(def.seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const money = (lo: number, hi: number, step = 5000) => Math.round((lo + r() * (hi - lo)) / step) * step
  const bank: Omit<BankLine, 'id'>[] = []
  const book: Omit<BookEntry, 'id'>[] = []
  const bal = new Map<string, number>()
  const clientOf = new Map(def.matters)
  let line = 2, cheque = def.id === 'reyes' ? 1150 : 2210, inv = def.id === 'reyes' ? 5120 : 1031
  const lastDay = dayNum(monthEnd(LAST))
  const addBook = (date: string, matter: string, amount: number, desc: string, payee: string, ref: string, kind: BookEntry['kind']) => {
    book.push({ line: 0, date, amount, matter, client: matter ? clientOf.get(matter) ?? '' : '', ref, desc, payee, kind })
    if (matter) bal.set(matter, (bal.get(matter) ?? 0) + amount)
  }
  const addBank = (d: number, amount: number, desc: string, ref = '') => { bank.push({ line: line++, date: fromDayNum(d), amount, desc, ref }) }

  // Opening balances carried in from before the sample starts (dormant matters keep theirs).
  const openDate = fromDayNum(dayNum(`${FIRST}-01`) - 1)
  const openings: [string, number][] = def.id === 'reyes'
    ? [['PI-2025-112', 1850000], ['ES-2024-118', 321240], ['ES-2026-007', 4200000], ['PI-2026-018', 650000]]
    : [['FL-2025-088', 184500], ['FL-2026-014', 500000], ['FL-2026-019', 350000]]
  for (const [m, c] of openings) addBook(openDate, m, c, 'Opening balance', '', '', 'opening')
  const dormant = def.id === 'reyes' ? 'ES-2024-118' : 'FL-2025-088'

  // Funds a matter may spend: deposits count only once the bank has them.
  const avail = new Map(openings)
  let pending: { matter: string; amount: number; clear: number }[] = []
  const settle = (d: number) => {
    for (const p of pending) if (p.clear < d) avail.set(p.matter, (avail.get(p.matter) ?? 0) + p.amount)
    pending = pending.filter(p => p.clear >= d)
  }
  const scripted = def.id === 'reyes' ? ['PI-2026-031', 'PI-2026-044', 'ES-2026-007', 'ES-2026-013'] : ['FL-2026-047']
  const payees = def.id === 'reyes'
    ? ['Maricopa County Superior Court', 'Banner Health Records', 'Desert Imaging LLC', 'Copperstate Court Reporting', 'Arizona Dept. of Revenue']
    : ['Ontario Superior Court of Justice', 'Teranet Express', 'Ashgrove Family Mediation', 'Dr. P. Vance, assessor', 'Carleton Process Servers']

  for (let m = FIRST; m <= LAST; m = addMonths(m, 1)) {
    const start = dayNum(`${m}-01`), end = dayNum(monthEnd(m))
    const day = (lo = 0, hi = 27) => weekday(start + lo + Math.floor(r() * (hi - lo)))
    const active = def.matters.map(x => x[0]).filter(x => x !== dormant && !scripted.includes(x))
    type Ev = { d: number; t: 'dep' | 'chq' | 'fee'; batched?: boolean }
    const evs: Ev[] = []
    const deposits = 3 + Math.floor(r() * 3)
    const batchDay = day(4, 18)
    for (let i = 0; i < deposits; i++) evs.push(i < 2 && m !== FIRST ? { d: batchDay, t: 'dep', batched: true } : { d: Math.min(day(0, 24), end - 3), t: 'dep' })
    for (let i = 0; i < 2 + Math.floor(r() * 3); i++) evs.push({ d: day(2, 26), t: 'chq' })
    for (let i = 0; i < 2; i++) evs.push({ d: day(8, 27), t: 'fee' })
    evs.sort((x, y) => x.d - y.d || (x.t === 'dep' ? -1 : 1))
    const batch: number[] = []
    let firstCheque = true
    for (const ev of evs) {
      settle(ev.d)
      const date = fromDayNum(ev.d)
      if (ev.t === 'dep') {
        const mt = pick(active)
        const amt = def.id === 'reyes' && r() < 0.3 ? money(800000, 3500000, 50000) : money(150000, 750000, 25000)
        const via = ev.batched ? 'cheque' : pick(['e-transfer', 'wire', 'cheque'])
        const ref = via === 'wire' ? `W${Math.floor(r() * 90000 + 10000)}` : via === 'e-transfer' ? `ET${Math.floor(r() * 900000 + 100000)}` : ''
        addBook(date, mt, amt, via === 'wire' ? 'Wire received' : via === 'e-transfer' ? (def.currency === 'CAD' ? 'Interac e-Transfer received' : 'ACH received') : 'Retainer cheque deposited', clientOf.get(mt)!, ref, 'deposit')
        const clear = ev.batched ? batchDay + 1 : ev.d + (via === 'cheque' ? 1 : 0)
        pending.push({ matter: mt, amount: amt, clear })
        if (ev.batched) batch.push(amt)
        else addBank(clear, amt, via === 'wire' ? `INCOMING WIRE ${ref}` : via === 'e-transfer' ? (def.currency === 'CAD' ? `E-TRANSFER DEPOSIT ${ref}` : `ACH CREDIT ${ref}`) : 'BRANCH DEPOSIT')
        continue
      }
      const floor = ev.t === 'chq' ? 60000 : 150000
      const mt = pick(active.filter(x => (avail.get(x) ?? 0) > floor))
      if (!mt) continue
      const room = (avail.get(mt) ?? 0) - (ev.t === 'chq' ? 20000 : 50000)
      const amt = -Math.min(ev.t === 'chq' ? money(8500, 95000, 500) : money(60000, 240000, 500), room)
      avail.set(mt, (avail.get(mt) ?? 0) + amt)
      if (ev.t === 'chq') {
        const no = String(cheque++)
        const payee = pick(payees)
        addBook(date, mt, amt, `Cheque to ${payee}`, payee, no, 'disbursement')
        // In the clean sample the first cheque written in the last month is still outstanding.
        const outstanding = def.id === 'marlowe' && m === LAST && firstCheque
        firstCheque = false
        if (!outstanding) addBank(ev.d + 2 + Math.floor(r() * 10), amt, `CHEQUE ${no}`, no)
      } else {
        const ref = `INV-${inv++}`
        addBook(date, mt, amt, `Fees per invoice ${ref}`, `${def.name} operating`, ref, 'disbursement')
        addBank(ev.d, amt, `TRANSFER TO ${def.operating} ${ref}`)
      }
    }
    if (batch.length) addBank(batchDay + 1, batch.reduce((a, c) => a + c, 0), `BRANCH DEPOSIT ${batch.length} ITEMS`)
  }

  // Scripted events for the problem month.
  if (def.id === 'reyes') {
    const at = (d: string) => dayNum(`2026-10-${d}`)
    // Negative ledger: records fee paid with only part of the retainer received.
    addBook('2026-10-05', 'PI-2026-031', 200000, 'Retainer cheque deposited', 'Gutierrez, Marisol', '', 'deposit'); addBank(at('06'), 200000, 'BRANCH DEPOSIT')
    addBook('2026-10-14', 'PI-2026-031', -235000, 'Cheque to Banner Health Records', 'Banner Health Records', '1190', 'disbursement'); addBank(at('19'), -235000, 'CHEQUE 1190', '1190')
    // Paid out of a settlement before the settlement cheque cleared.
    addBook('2026-10-20', 'PI-2026-044', 6000000, 'Settlement cheque, Sonoran Mutual Ins.', 'Sonoran Mutual Insurance', '', 'deposit'); addBank(at('27'), 6000000, 'BRANCH DEPOSIT')
    addBook('2026-10-22', 'PI-2026-044', -3900000, 'Settlement proceeds to client', 'Duran, Lucia', '1191', 'disbursement'); addBank(at('23'), -3900000, 'CHEQUE 1191', '1191')
    // The Transfer Funds mistake: fees moved at the account level, no client ledger reduced.
    addBook('2026-10-15', '', -450000, 'Transfer Funds to operating (Okafor fees)', 'Reyes Injury & Estates operating', 'TRF-1015', 'transfer'); addBank(at('15'), -450000, 'ONLINE TRANSFER TO OPERATING ...4471')
    // And one never recorded at all.
    addBank(at('28'), -125000, 'ONLINE TRANSFER TO OPERATING ...4471 BEGAY')
    // Outstanding cheque at month end.
    addBook('2026-10-29', 'ES-2026-007', -1240000, 'Partial distribution to beneficiary', 'Lindqvist, Karin', '1192', 'disbursement')
    addBook('2026-10-30', 'ES-2026-013', 8500, 'Recording fee advance', 'Estate of M. Abernathy', '', 'deposit'); addBank(at('30'), 8500, 'MOBILE DEPOSIT')
    addBook('2026-10-30', 'ES-2026-013', -8500, 'Cheque to Maricopa County Recorder', 'Maricopa County Recorder', '1193', 'disbursement')
    // Bank fee straight out of trust.
    addBank(at('30'), -1500, 'MONTHLY SERVICE FEE')
    // Retainer keyed in twice.
    addBook('2026-10-09', 'PI-2026-040', 150000, 'Retainer, ACH', 'Okafor, Emeka', 'ACH-88213', 'deposit'); addBank(at('09'), 150000, 'ACH CREDIT ACH-88213')
    addBook('2026-10-09', 'PI-2026-040', 150000, 'Retainer, ACH', 'Okafor, Emeka', 'ACH-88213', 'deposit')
  } else {
    // A retainer deposited on the last business day clears in November.
    addBook('2026-10-30', 'FL-2026-047', 250000, 'Retainer cheque deposited', 'Abara, Chidi', '', 'deposit')
  }

  const bankCut = bank.filter(b => dayNum(b.date) <= lastDay).sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  let run = openings.reduce((a, [, c]) => a + c, 0)
  const bankRows = bankCut.map((b, i) => { run += b.amount; return { ...b, id: '', line: i + 2, balance: run } })
  const bookRows = book.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount).map((e, i) => ({ ...e, id: '', line: i + 2 }))
  const ids = assignBookIds(bookRows)
  return { bank: assignBankIds(bankRows), book: ids, balances: listing(def, ids, LAST) }
}

function listing(def: SampleDef, book: BookEntry[], month: string) {
  const dormant = def.id === 'reyes' ? 'ES-2024-118' : 'FL-2025-088'
  return balancesFor(book, month).map(b => b.matter === dormant && def.dormantSince ? { ...b, lastActivity: def.dormantSince } : b)
}

/** What the trust listing report would show at a month end: one balance per matter. Account-level entries do not appear. */
export function balancesFor(book: BookEntry[], month: string): LedgerBalance[] {
  const end = monthEnd(month)
  const by = new Map<string, LedgerBalance>()
  for (const e of book) {
    if (!e.matter || e.date > end) continue
    const b = by.get(e.matter) ?? { matter: e.matter, client: e.client, balance: 0, asOf: end, line: 0 }
    b.balance += e.amount
    if (e.kind !== 'opening') b.lastActivity = !b.lastActivity || e.date > b.lastActivity ? e.date : b.lastActivity
    by.set(e.matter, b)
  }
  return [...by.values()].filter(b => b.balance !== 0).sort((a, b) => a.matter.localeCompare(b.matter)).map((b, i) => ({ ...b, line: i + 2 }))
}

export function sampleConfig(def: SampleDef, ds: Dataset): Config {
  const st = statementsFromBalances(ds.bank)
  return {
    statements: Object.fromEntries(Object.entries(st).map(([m, v]) => [m, { ...v, source: 'file' as const }])),
    settings: { ...DEFAULT_SETTINGS }, manual: [], rejected: [], jurisdiction: def.jurisdiction, currency: def.currency,
    accountName: `${def.bankName} trust account`,
  }
}

const d2 = (c: number) => (c / 100).toFixed(2)

/** The sample as the three files a user would export, for rehearsing the import. */
export function sampleFiles(def: SampleDef, ds: Dataset, month: string): Record<string, string> {
  const inM = (d: string) => d.startsWith(month)
  const bank = toCsv([['Posting Date', 'Description', 'Amount', 'Check or Slip #', 'Balance'], ...ds.bank.filter(b => inM(b.date)).map(b => [b.date, b.desc, d2(b.amount), b.ref, b.balance !== undefined ? d2(b.balance) : ''])])
  const journal = toCsv([['Date', 'Source/Destination', 'Payer/Payee', 'Client', 'Matter', 'Description', 'Reference', 'Funds in', 'Funds out'], ...ds.book.filter(e => e.date <= monthEnd(month)).map(e => [e.date, e.kind === 'transfer' ? 'Transfer' : e.kind === 'opening' ? 'Opening balance' : e.amount > 0 ? 'Deposit' : 'Disbursement', e.payee, e.client, e.matter, e.desc, e.ref, e.amount > 0 ? d2(e.amount) : '', e.amount < 0 ? d2(-e.amount) : ''])])
  const trustListing = toCsv([['Client', 'Matter', 'Trust Balance', 'Last Activity'], ...listing(def, ds.book, month).map(b => [b.client, b.matter, d2(b.balance), b.lastActivity ?? ''])])
  return { [`${def.id}-bank-${month}.csv`]: bank, [`${def.id}-trust-ledger-${month}.csv`]: journal, [`${def.id}-trust-listing-${month}.csv`]: trustListing }
}
