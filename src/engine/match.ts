import { dayNum } from './dates.ts'
import type { BankLine, BookEntry, ManualMatch, MatchSettings } from './types.ts'

export type MatchHow = 'manual' | 'cheque' | 'amount' | 'batch'
export interface Match { key: string; bank: string[]; book: string[]; how: MatchHow; gap: number }
export interface MatchResult { matches: Match[]; bankOnly: BankLine[]; bookOnly: BookEntry[] }

export const matchKey = (bank: string[], book: string[]) => `${[...bank].sort().join('+')}=${[...book].sort().join('+')}`
const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '')

/**
 * Matches bank lines to journal entries.
 * Order: manual pairings, cheque number + amount, amount + closest date, then batched deposits
 * (one bank line equal to the sum of several journal entries on the same side).
 */
export function matchItems(bank: BankLine[], book: BookEntry[], s: MatchSettings, manual: ManualMatch[] = [], rejected: string[] = []): MatchResult {
  const rej = new Set(rejected)
  const freeBank = new Map(bank.map(b => [b.id, b]))
  const freeBook = new Map(book.filter(e => e.kind !== 'opening').map(e => [e.id, e]))
  const matches: Match[] = []
  const take = (bs: BankLine[], es: BookEntry[], how: MatchHow) => {
    for (const b of bs) freeBank.delete(b.id)
    for (const e of es) freeBook.delete(e.id)
    const gap = Math.max(...bs.flatMap(b => es.map(e => Math.abs(dayNum(b.date) - dayNum(e.date)))))
    matches.push({ key: matchKey(bs.map(b => b.id), es.map(e => e.id)), bank: bs.map(b => b.id), book: es.map(e => e.id), how, gap })
  }

  for (const m of manual) {
    const bs = m.bank.map(id => freeBank.get(id))
    const es = m.book.map(id => freeBook.get(id))
    if (bs.every(Boolean) && es.every(Boolean) && bs.length && es.length) take(bs as BankLine[], es as BookEntry[], 'manual')
  }

  // Bank date must not be much earlier than the journal date; cheques may clear late.
  const fits = (b: BankLine, e: BookEntry, window: number) => {
    const d = dayNum(b.date) - dayNum(e.date)
    return d >= -3 && d <= window
  }

  // Cheque number + amount.
  for (const b of [...freeBank.values()]) {
    const n = digits(b.ref)
    if (!n) continue
    const e = [...freeBook.values()].find(e => digits(e.ref) === n && e.amount === b.amount && fits(b, e, s.chequeWindow) && !rej.has(matchKey([b.id], [e.id])))
    if (e) take([b], [e], 'cheque')
  }

  // Amount + date: take globally closest pairs first so one early guess cannot steal a better match.
  const pairs: { b: BankLine; e: BookEntry; gap: number; refBonus: number }[] = []
  for (const b of freeBank.values()) for (const e of freeBook.values()) {
    if (e.amount !== b.amount) continue
    const window = b.amount < 0 && digits(e.ref) ? s.chequeWindow : s.dateWindow
    if (!fits(b, e, window) || rej.has(matchKey([b.id], [e.id]))) continue
    // A bank line that carries a cheque number must not match a different cheque.
    if (digits(b.ref) && digits(e.ref) && digits(b.ref) !== digits(e.ref)) continue
    pairs.push({ b, e, gap: Math.abs(dayNum(b.date) - dayNum(e.date)), refBonus: refOverlap(b, e) })
  }
  pairs.sort((x, y) => x.gap - y.gap || y.refBonus - x.refBonus || x.b.date.localeCompare(y.b.date) || x.e.line - y.e.line)
  for (const p of pairs) if (freeBank.has(p.b.id) && freeBook.has(p.e.id)) take([p.b], [p.e], 'amount')

  // Batched deposits (and batched transfers out): one bank line = several journal entries.
  for (const b of [...freeBank.values()].sort((x, y) => x.date.localeCompare(y.date))) {
    const cands = [...freeBook.values()]
      .filter(e => Math.sign(e.amount) === Math.sign(b.amount) && Math.abs(e.amount) < Math.abs(b.amount) && fits(b, e, s.dateWindow))
      .sort((x, y) => Math.abs(dayNum(b.date) - dayNum(x.date)) - Math.abs(dayNum(b.date) - dayNum(y.date)))
      .slice(0, 18)
    const found = subsetSum(cands, b.amount, s.batchMax)
    if (found && !rej.has(matchKey([b.id], found.map(e => e.id)))) take([b], found, 'batch')
  }

  return { matches, bankOnly: [...freeBank.values()], bookOnly: [...freeBook.values()] }
}

function refOverlap(b: BankLine, e: BookEntry): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2))
  const a = words(b.desc + ' ' + b.ref)
  let n = 0
  for (const w of words(`${e.desc} ${e.payee} ${e.client} ${e.ref}`)) if (a.has(w)) n++
  return n
}

/** Smallest exact subset (2..max items) summing to target; depth-first with pruning. */
export function subsetSum<T extends { amount: number }>(items: T[], target: number, max: number): T[] | null {
  const sorted = [...items].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  const abs = Math.abs(target)
  const vals = sorted.map(i => Math.abs(i.amount))
  const suffix = vals.map((_, i) => vals.slice(i).reduce((a, v) => a + v, 0))
  let best: number[] | null = null
  let steps = 0
  const pick: number[] = []
  const go = (i: number, sum: number) => {
    if (++steps > 200_000) return
    if (sum === abs && pick.length >= 2) { if (!best || pick.length < best.length) best = [...pick]; return }
    if (i >= vals.length || pick.length >= max || sum > abs || sum + suffix[i] < abs) return
    if (best && pick.length + 1 >= best.length) return
    pick.push(i); go(i + 1, sum + vals[i]); pick.pop()
    go(i + 1, sum)
  }
  go(0, 0)
  return best ? (best as number[]).map(i => sorted[i]) : null
}
