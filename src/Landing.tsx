import { useEffect, useMemo, useRef, useState } from 'react'
import { reconcileAll, EX_LABEL, type MonthRecon } from './engine/recon.ts'
import { LAST, SAMPLES, sampleConfig } from './engine/sample.ts'
import type { BankLine, BookEntry } from './engine/types.ts'
import { sampleDataset } from './projectData.ts'
import { fmtDay, Link, money, setCurrency } from './ui.tsx'

type Which = 'marlowe' | 'reyes'

function useHeroData(which: Which) {
  return useMemo(() => {
    const def = SAMPLES.find(s => s.id === which)!
    const ds = sampleDataset(which)!
    const r = reconcileAll(ds, sampleConfig(def, ds)).get(LAST)!
    const bookIds = new Set([...r.matches.flatMap(m => m.book), ...r.outstandingDeposits.map(e => e.id), ...r.outstandingCheques.map(e => e.id)])
    const book = ds.book.filter(e => (e.date >= r.start && e.date <= r.end) || bookIds.has(e.id)).filter(e => e.kind !== 'opening')
    const bank = [...r.bankLines, ...r.bankOnly.filter(b => b.date < r.start)].sort((a, b) => a.date.localeCompare(b.date))
    // Play matches in bank-date order so the columns read top to bottom.
    const bankDate = new Map(bank.map(b => [b.id, b.date]))
    const order = [...r.matches].sort((a, b) => (bankDate.get(a.bank[0]) ?? '').localeCompare(bankDate.get(b.bank[0]) ?? ''))
    book.sort((a, b) => a.date.localeCompare(b.date))
    return { def, r, bank, book, order }
  }, [which])
}

function TieOutHero() {
  const [which, setWhich] = useState<Which>('marlowe')
  const [auto, setAuto] = useState(true)
  const { def, r, bank, book, order } = useHeroData(which)
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const [step, setStep] = useState(reduced ? Infinity : 0)
  const total = order.length
  const done = step >= total
  const snapped = step >= total + 2

  useEffect(() => { setStep(reduced ? Infinity : 0) }, [which, reduced])
  useEffect(() => {
    if (reduced) return
    const delay = step < total ? 520 : step < total + 2 ? 900 : null
    if (delay !== null) { const t = setTimeout(() => setStep(s => s + 1), delay); return () => clearTimeout(t) }
    if (auto) { const t = setTimeout(() => setWhich(w => w === 'marlowe' ? 'reyes' : 'marlowe'), 6500); return () => clearTimeout(t) }
  }, [step, total, auto, reduced])

  setCurrency(def.currency)
  const active = step < total ? order[step] : null
  const matchedBank = new Set(order.slice(0, Math.min(step, total)).flatMap(m => m.bank))
  const matchedBook = new Set(order.slice(0, Math.min(step, total)).flatMap(m => m.book))
  const activeBank = new Set(active?.bank ?? [])
  const activeBook = new Set(active?.book ?? [])
  const activeMatters = new Set(book.filter(e => activeBook.has(e.id)).map(e => e.matter))
  const flaggedBook = new Set(r.exceptions.flatMap(e => e.bookIds))
  const flaggedBank = new Set(r.exceptions.flatMap(e => e.bankIds))
  const flaggedMatter = new Set(r.exceptions.filter(e => e.severity !== 'info' || e.kind === 'stale').map(e => e.matter).filter(Boolean))

  const cls = (id: string, act: Set<string>, matched: Set<string>, flagged: Set<string>) =>
    `tie-item${act.has(id) ? ' active' : ''}${matched.has(id) && !act.has(id) ? ' matched' : ''}${done && !matched.has(id) ? (flagged.has(id) ? ' flag' : ' out') : ''}`

  const bankRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<HTMLDivElement>(null)
  const cliRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    for (const box of [bankRef.current, bookRef.current, cliRef.current]) {
      const el = box?.querySelector<HTMLElement>('.active')
      if (box && el) box.scrollTo({ top: Math.max(0, el.offsetTop - box.offsetTop - 90), behavior: 'smooth' })
      else if (box && done) box.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [step, done])

  const diffs = diffChips(r)
  const pick = (w: Which) => { setAuto(false); setWhich(w) }

  return (
    <div className={`tie${snapped ? ' snapped' : ''}`} aria-label="Live three-way reconciliation of a synthetic firm's October statement">
      <div className="tie-bar">
        <div className="tie-seg" role="group" aria-label="Sample month">
          <button type="button" aria-pressed={which === 'marlowe'} onClick={() => pick('marlowe')}>Clean month</button>
          <button type="button" aria-pressed={which === 'reyes'} onClick={() => pick('reyes')}>The Transfer mistake</button>
        </div>
        <span className={`tie-status${snapped ? (r.tiesOut ? ' done' : ' off') : ''}`} aria-live="polite">
          <i aria-hidden="true" />{done ? (r.tiesOut ? 'Ties out' : `${r.exceptions.filter(e => e.severity === 'critical').length} critical findings`) : `Matching ${Math.min(step + 1, total)} of ${total}`} · {def.name} (synthetic) · October 2026
        </span>
      </div>
      <div className="tie-cols">
        <section className="tie-col" style={{ ['--c' as string]: 'var(--col-bank)' }}>
          <h4><span>Bank statement</span><span>{matchedBank.size}/{bank.length}</span></h4>
          <div className="tie-total">{money(r.statement.closing)}</div>
          <div className="tie-list" ref={bankRef}>
            {bank.map((b: BankLine) => (
              <div key={b.id} className={cls(b.id, activeBank, matchedBank, flaggedBank)}>
                <span className="d">{fmtDay(b.date)}</span><span className="t">{b.desc}</span><span className="a">{money(b.amount, { cents: false })}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="tie-col" style={{ ['--c' as string]: 'var(--col-book)' }}>
          <h4><span>Trust journal</span><span>{matchedBook.size}/{book.length}</span></h4>
          <div className="tie-total">{money(r.journal)}</div>
          <div className="tie-list" ref={bookRef}>
            {book.map((e: BookEntry) => (
              <div key={e.id} className={cls(e.id, activeBook, matchedBook, flaggedBook)}>
                <span className="d">{fmtDay(e.date)}</span><span className="t">{e.matter ? `${e.matter} · ` : 'No client · '}{e.desc}</span><span className="a">{money(e.amount, { cents: false })}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="tie-col" style={{ ['--c' as string]: 'var(--col-client)' }}>
          <h4><span>Client ledgers</span><span>{r.clients.length} matters</span></h4>
          <div className="tie-total">{money(r.clientTotal)}</div>
          <div className="tie-list" ref={cliRef}>
            {r.clients.map(c => (
              <div key={c.matter} className={`tie-item${activeMatters.has(c.matter) ? ' active' : ''}${c.balance < 0 || c.minBalance < 0 ? ' neg' : ''}${done && flaggedMatter.has(c.matter) ? ' flag' : ''}`}>
                <span className="d">{c.matter.split('-').at(-1)}</span><span className="t">{c.client}</span><span className="a">{money(c.balance, { cents: false })}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="tie-foot">
        <div className="tie-eq"><span>Adjusted bank</span><b>{done ? money(r.adjustedBank) : '…'}</b></div>
        <div className="tie-eq"><span>{done ? (r.adjustedBank === r.journal ? '=' : '≠') : ''} Journal</span><b>{money(r.journal)}</b></div>
        <div className="tie-eq"><span>{done ? (r.journal === r.clientTotal ? '=' : '≠') : ''} Client ledgers</span><b>{money(r.clientTotal)}</b></div>
        <div className={`tie-result${snapped ? (r.tiesOut ? ' ok' : ' off') : ''}`}>
          {!done && <span>Matching bank lines to journal entries by cheque number, amount and date, including batched deposits.</span>}
          {done && r.tiesOut && <><span className="big">Ties out to the cent.</span><div className="tie-diffs">{diffs.map(d => <span key={d}>{d}</span>)}</div></>}
          {done && !r.tiesOut && <><span className="big">Off, and every dollar explained:</span><div className="tie-diffs">{diffs.map(d => <span key={d}>{d}</span>)}</div></>}
        </div>
      </div>
    </div>
  )
}

function diffChips(r: MonthRecon): string[] {
  const out: string[] = []
  if (r.dit) out.push(`${money(r.dit, { cents: false })} deposits in transit`)
  if (r.oc) out.push(`${money(r.oc, { cents: false })} outstanding cheques`)
  if (r.tiesOut) { if (r.matches.some(m => m.how === 'batch')) out.push('batched deposit split 1 → 2'); return out }
  const seen = new Set<string>()
  for (const e of r.exceptions.filter(x => x.severity !== 'info')) {
    if (seen.has(e.kind)) continue
    seen.add(e.kind)
    out.push(`${EX_LABEL[e.kind]} ${money(e.amount, { cents: false })}`)
    if (out.length >= 6) break
  }
  return out
}

export function Landing() {
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div className="eyebrow on-dark"><i aria-hidden="true" />Three-way trust reconciliation</div>
          <h1>Trust that ties&nbsp;out.</h1>
          <p className="hero-lede">Bank statement, trust journal and every client ledger, reconciled to the cent each month. Every difference explained. A signed report ready for the auditor.</p>
          <div className="hero-cta">
            <Link href="/app?sample=reyes" className="btn accent">Try the sample firm</Link>
            <Link href="/app" className="btn ghost on-dark">Reconcile your account</Link>
          </div>
          <TieOutHero />
          <p className="hero-note">Live: the real reconciliation engine running on a synthetic firm. Your files are processed the same way, in this browser.</p>
        </div>
      </section>

      <section className="section">
        <div className="eyebrow">Why monthly</div>
        <h2 className="big">$156,000 in the ledger. $0 in the bank.</h2>
        <div className="story">
          <div>
            <p className="story-quote">
              A lawyer posted that their practice software showed a trust running balance of about $156,000, while the bank showed nothing at all. For years they had paid themselves with “Transfer Funds” instead of “Disburse Funds”. The money left the account. It never left any client’s ledger.
              <small>Paraphrased from a public Clio user forum thread</small>
            </p>
            <p className="lede">The advice they got was the right advice: reconcile, find each discrepancy, and fix the client ledgers. Trust Reconcile does that work every month, so a problem is one entry, not five years of them.</p>
          </div>
          <div className="ledger-compare" aria-label="Example of the Transfer versus Disburse mistake">
            <div><span>Client ledgers say</span><b>$156,000</b></div>
            <div><span>The bank says</span><b>$0</b></div>
            <div className="explain">
              Each “Transfer Funds” moved real money to operating but posted it to no client. The three-way tie-out shows it as journal entries <em>with no client</em>, flags each one, and writes the reversing and disbursing entries that put the right client ledger back.
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="eyebrow">What it finds</div>
        <h2 className="big">The things an auditor finds, found first.</h2>
        <div className="cards">
          <article className="card manila"><span className="card-tag">Transfer vs Disburse</span><h3>Fees moved with no client</h3><p>Transfers to operating with no matter or no invoice, including ones the journal never recorded.</p></article>
          <article className="card lavender"><span className="card-tag">Ethics red flag</span><h3>Negative client ledgers</h3><p>Any client whose balance dipped below zero during the month, even if it recovered by month end.</p></article>
          <article className="card blue"><span className="card-tag">Uncleared funds</span><h3>Paid before it cleared</h3><p>Disbursements made against a deposit the bank had not cleared yet, so other clients’ money covered it.</p></article>
          <article className="card stone"><span className="card-tag">Dormant</span><h3>Stale balances</h3><p>Money sitting untouched for months, with a draft letter to the client ready to print.</p></article>
          <article className="card green"><span className="card-tag">Commingling</span><h3>Fees and interest in trust</h3><p>Bank charges taken from client money and interest that belongs to the IOLTA program or law foundation.</p></article>
          <article className="card"><span className="card-tag">Keying errors</span><h3>Duplicates and strays</h3><p>Entries recorded twice, deposits on the statement that are not in the journal, cheques gone stale.</p></article>
        </div>
      </section>

      <section className="section">
        <div className="eyebrow">How it works</div>
        <h2 className="big">One sitting, once a month.</h2>
        <ol className="steps">
          <li><h3>Import three files</h3><p>The bank statement (CSV, OFX or QFX), the trust ledger from Clio Manage, QuickBooks or any CSV, and client balances. Columns are detected and every bad line is reported by number.</p></li>
          <li><h3>Match</h3><p>Cheque numbers, amounts and dates, including one deposit slip that covers several retainers. Uncleared items carry into next month by themselves.</p></li>
          <li><h3>Explain</h3><p>Adjusted bank, journal and client ledgers side by side. Every cent of difference points at an item, with the correcting entry written for you.</p></li>
          <li><h3>Sign</h3><p>Print the monthly reconciliation with reconciler and reviewer lines. The compliance calendar shows which months are done and signed.</p></li>
        </ol>
      </section>

      <section className="section">
        <div className="privacy-band">
          <div>
            <div className="eyebrow on-dark">Privacy</div>
            <h2>Client names stay on this device.</h2>
            <p>Law society and bar rules care where client information goes, and so do firms worried about data residency. Statements and ledgers are parsed and reconciled entirely in your browser.</p>
            <Link href="/docs#privacy" className="btn white sm">What stays local</Link>
          </div>
          <ul>
            <li>No upload. Files are read in the browser and kept in its local storage.</li>
            <li>No account needed. Sign in only if you want the same reconciliations on another computer.</li>
            <li>“Sync only totals” is on by default: balances, counts and sign-offs sync; client names, matters, payees and raw files never do.</li>
            <li>Export everything as JSON, or delete your cloud copy and account, from the account menu.</li>
          </ul>
        </div>
      </section>

      <section className="section">
        <div className="eyebrow">Works with what you have</div>
        <h2 className="big">Keep your software. Check it.</h2>
        <p className="lede">Small firms ask which legal accounting software to use, and whether theirs is just the least terrible option. Whatever you chose, the monthly question is the same: do the bank, the journal and the client ledgers agree?</p>
        <div className="cards">
          <article className="card"><span className="card-tag">Practice management</span><h3>Clio Manage</h3><p>Trust ledger and trust listing reports, exported as CSV. Step-by-step in the docs.</p></article>
          <article className="card"><span className="card-tag">Accounting</span><h3>QuickBooks</h3><p>Transaction detail by account for the trust bank account, with Customer:Job as the matter.</p></article>
          <article className="card"><span className="card-tag">Banks</span><h3>CSV, OFX, QFX</h3><p>Chase, Bank of America, Wells Fargo, RBC, TD and anything with a date and an amount.</p></article>
        </div>
      </section>

      <section className="cta-final">
        <h2>Close the month.</h2>
        <div className="row gap center-x wrap">
          <Link href="/app?sample=reyes" className="btn accent">Open the problem firm</Link>
          <Link href="/app?sample=marlowe" className="btn ghost">Open the clean firm</Link>
          <Link href="/docs" className="btn ghost">Read the docs</Link>
        </div>
      </section>
    </>
  )
}
