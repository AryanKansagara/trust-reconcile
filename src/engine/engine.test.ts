import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDate, parseMoney, monthEnd, addMonths } from './dates.ts'
import { assignBankIds, assignBookIds, chequeIn, classify, decodeText, detect, dropPreamble, ofxAccountLabel, parseCsv, parseOfx, parseOfxAccounts, statementsFromBalances, validate } from './importer.ts'
import { matchItems, subsetSum } from './match.ts'
import { correctionRows, reconcileAll } from './recon.ts'
import { SAMPLES, generate, sampleConfig, sampleFiles } from './sample.ts'
import { cloudSnapshot, complianceCalendar, dueDate, makeSnapshot } from './snapshot.ts'
import { DEFAULT_SETTINGS, type BankLine, type BookEntry, type Config, type Dataset } from './types.ts'

const S = DEFAULT_SETTINGS
const bk = (date: string, amount: number, desc = 'DEPOSIT', ref = ''): BankLine => ({ id: '', line: 0, date, amount, desc, ref })
const jr = (date: string, amount: number, matter = 'M-1', extra: Partial<BookEntry> = {}): BookEntry => ({ id: '', line: 0, date, amount, matter, client: matter ? `Client ${matter}` : '', ref: '', desc: amount > 0 ? 'Deposit' : 'Payment', payee: '', kind: amount > 0 ? 'deposit' : 'disbursement', ...extra })
const ids = <T extends { id: string; line: number }>(xs: T[], p: string) => xs.map((x, i) => ({ ...x, id: `${p}${i}`, line: i + 2 }))
const cfg = (p: Partial<Config> = {}): Config => ({ statements: {}, settings: { ...S }, manual: [], rejected: [], jurisdiction: 'aba', currency: 'USD', accountName: 'Trust', ...p })

// ---------- Parsing ----------

test('parseMoney handles currency, parentheses, trailing minus, DR/CR and European decimals', () => {
  assert.equal(parseMoney('$1,234.50'), 123450)
  assert.equal(parseMoney('(1,234.50)'), -123450)
  assert.equal(parseMoney('85.00-'), -8500)
  assert.equal(parseMoney('12.00 DR'), -1200)
  assert.equal(parseMoney('1.234,56'), 123456)
  assert.equal(parseMoney('-0.10'), -10)
  assert.ok(Number.isNaN(parseMoney('abc')))
  assert.ok(Number.isNaN(parseMoney('')))
})

test('parseDate reads ISO, US, day-first, OFX and month-name dates and rejects impossible ones', () => {
  assert.equal(parseDate('2026-10-31'), '2026-10-31')
  assert.equal(parseDate('10/31/2026'), '2026-10-31')
  assert.equal(parseDate('31/10/2026'), '2026-10-31')
  assert.equal(parseDate('05/10/2026', true), '2026-10-05')
  assert.equal(parseDate('20261031120000[-7:MST]'), '2026-10-31')
  assert.equal(parseDate('Oct 31, 2026'), '2026-10-31')
  assert.equal(parseDate('31-Oct-2026'), '2026-10-31')
  assert.equal(parseDate('2026-02-30'), null)
  assert.equal(monthEnd('2028-02'), '2028-02-29')
  assert.equal(addMonths('2026-11', 3), '2027-02')
})

test('parseCsv keeps quoted commas and newlines and reports the line each record starts on', () => {
  const { rows, lines } = parseCsv('Date,Description,Amount\n2026-10-01,"Smith, J ""retainer""",100\n2026-10-02,"two\nlines",5\n')
  assert.equal(rows[1][1], 'Smith, J "retainer"')
  assert.deepEqual(lines, [1, 2, 3])
  assert.equal(rows[2][1], 'two\nlines')
})

test('OFX (SGML, unclosed tags) yields transactions, cheque numbers and the ledger balance', () => {
  const ofx = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20261014<TRNAMT>-235.00<FITID>1<CHECKNUM>1190<NAME>CHECK 1190
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261020120000[-7:MST]<TRNAMT>60000.00<FITID>2<NAME>DEPOSIT<MEMO>Branch
</BANKTRANLIST><LEDGERBAL><BALAMT>1520.40<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
  const r = parseOfx(ofx)
  assert.equal(r.lines.length, 2)
  assert.equal(r.lines[0].ref, '1190')
  assert.equal(r.lines[0].amount, -23500)
  assert.equal(r.lines[1].date, '2026-10-20')
  assert.equal(r.lines[1].desc, 'DEPOSIT · Branch')
  assert.equal(r.closing, 152040)
})

test('format detection recognises Clio trust ledger, trust listing, QuickBooks and bank layouts', () => {
  assert.equal(detect([['Date', 'Source/Destination', 'Payer/Payee', 'Matter', 'Description', 'Reference', 'Funds in', 'Funds out']]).format, 'Clio Manage trust ledger report')
  assert.equal(detect([['Client', 'Matter', 'Trust Balance']]).kind, 'balances')
  assert.equal(detect([['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Split', 'Amount']]).kind, 'book')
  assert.equal(detect([['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #']]).format, 'Chase activity CSV')
  const wf = detect([['10/02/2026', '-85.00', '*', '1193', 'CHECK 1193']])
  assert.equal(wf.kind, 'bank')
  assert.equal(wf.hasHeader, false)
  assert.equal(wf.map.amount, 1)
  assert.equal(detect([['foo', 'bar']]).kind, null)
})

test('validation reports problems with their line numbers and skips subtotal rows', () => {
  const csv = parseCsv('Date,Description,Amount\n2026-10-01,Deposit,100.00\nnot a date,Oops,5\n2026-10-03,Fee,abc\nTotal,,105\n2026-10-04,Zero,0\n')
  const d = detect(csv.rows)
  const v = validate('bank', csv, d.map, { hasHeader: true })
  assert.equal(v.rows.length, 1)
  assert.deepEqual(v.issues.filter(i => i.level !== 'skip').map(i => i.line), [3, 4])
  assert.ok(v.issues.some(i => i.line === 5 && /Subtotal/.test(i.message)))
  assert.equal(v.skipped, 4)
})

test('Clio funds in/out become signed amounts, client heading rows apply to the rows below', () => {
  const csv = parseCsv('Date,Matter,Description,Reference,Funds in,Funds out\nHale; Jordan\n2026-10-01,M-7,Retainer,,"1,000.00",\n2026-10-05,M-7,Court fee,1001,,85.00\n')
  const v = validate('book', csv, detect(csv.rows).map, { hasHeader: true })
  const rows = v.rows as BookEntry[]
  assert.deepEqual(rows.map(r => r.amount), [100000, -8500])
  assert.equal(rows[0].client, 'Hale; Jordan')
  assert.equal(rows[1].ref, '1001')
})

test('classify spots the Transfer Funds pattern, fees, interest and opening balances', () => {
  assert.equal(classify(-450000, 'Transfer Funds to operating'), 'transfer')
  assert.equal(classify(-100000, 'Fees to operating account'), 'transfer')
  assert.equal(classify(-1500, 'Monthly service charge'), 'fee')
  assert.equal(classify(312, 'Interest paid'), 'interest')
  assert.equal(classify(5000, 'Opening balance'), 'opening')
  assert.equal(classify(-8500, 'Cheque to county recorder'), 'disbursement')
})

test('ids are stable across re-imports and distinct for identical rows', () => {
  const a = assignBookIds([jr('2026-10-09', 1500), jr('2026-10-09', 1500)])
  const b = assignBookIds([jr('2026-10-09', 1500), jr('2026-10-09', 1500)])
  assert.notEqual(a[0].id, a[1].id)
  assert.deepEqual(a.map(x => x.id), b.map(x => x.id))
})

test('statement balances come from the running balance column in either sort order', () => {
  const lines = [{ ...bk('2026-10-02', 1000), balance: 11000 }, { ...bk('2026-10-20', -500), balance: 10500 }]
  assert.deepEqual(statementsFromBalances(lines)['2026-10'], { opening: 10000, closing: 10500 })
  assert.deepEqual(statementsFromBalances([...lines].reverse())['2026-10'], { opening: 10000, closing: 10500 })
})

// ---------- Matching ----------

test('cheques match by number even when another cheque has the same amount', () => {
  const bank = ids([bk('2026-10-20', -8500, 'CHEQUE 1002', '1002'), bk('2026-10-21', -8500, 'CHEQUE 1001', '1001')], 'b')
  const book = ids([jr('2026-10-05', -8500, 'M-1', { ref: '1001' }), jr('2026-10-06', -8500, 'M-2', { ref: '1002' })], 'j')
  const r = matchItems(bank, book, S)
  const byBank = Object.fromEntries(r.matches.map(m => [m.bank[0], m.book[0]]))
  assert.equal(byBank.b0, 'j1')
  assert.equal(byBank.b1, 'j0')
  assert.ok(r.matches.every(m => m.how === 'cheque'))
})

test('amount matching takes the closest date and respects the window', () => {
  const bank = ids([bk('2026-10-10', 50000)], 'b')
  const book = ids([jr('2026-10-01', 50000), jr('2026-10-09', 50000), jr('2026-09-01', 50000)], 'j')
  const r = matchItems(bank, book, S)
  assert.deepEqual(r.matches[0].book, ['j1'])
  assert.equal(r.bookOnly.length, 2)
  const far = matchItems(ids([bk('2026-10-30', 50000)], 'b'), ids([jr('2026-10-01', 50000)], 'j'), S)
  assert.equal(far.matches.length, 0)
})

test('a batched bank deposit matches the several journal receipts it is made of', () => {
  const bank = ids([bk('2026-10-15', 175000, 'BRANCH DEPOSIT 3 ITEMS')], 'b')
  const book = ids([jr('2026-10-14', 50000, 'A'), jr('2026-10-14', 25000, 'B'), jr('2026-10-14', 100000, 'C'), jr('2026-10-14', 40000, 'D')], 'j')
  const r = matchItems(bank, book, S)
  assert.equal(r.matches.length, 1)
  assert.equal(r.matches[0].how, 'batch')
  assert.deepEqual([...r.matches[0].book].sort(), ['j0', 'j1', 'j2'])
  assert.deepEqual(r.bookOnly.map(e => e.id), ['j3'])
})

test('subsetSum prefers the smallest exact combination and gives up cleanly', () => {
  const xs = [{ amount: 10 }, { amount: 20 }, { amount: 30 }, { amount: 60 }]
  assert.equal(subsetSum(xs, 90, 4)!.length, 2)
  assert.equal(subsetSum(xs, 7, 4), null)
})

test('manual matches win and rejected auto-matches are not made again', () => {
  const bank = ids([bk('2026-10-10', 50000)], 'b')
  const book = ids([jr('2026-10-10', 50000), jr('2026-10-12', 50000)], 'j')
  const manual = matchItems(bank, book, S, [{ bank: ['b0'], book: ['j1'] }])
  assert.deepEqual(manual.matches[0].book, ['j1'])
  assert.equal(manual.matches[0].how, 'manual')
  const rejected = matchItems(bank, book, S, [], ['b0=j0'])
  assert.deepEqual(rejected.matches[0].book, ['j1'])
})

// ---------- Reconciliation ----------

function tiny(): Dataset {
  return {
    bank: ids([bk('2026-09-03', 100000, 'DEPOSIT'), bk('2026-09-20', -20000, 'CHEQUE 501', '501'), bk('2026-10-04', -30000, 'CHEQUE 502', '502')], 'b'),
    book: ids([jr('2026-09-02', 100000, 'M-1'), jr('2026-09-15', -20000, 'M-1', { ref: '501' }), jr('2026-09-28', -30000, 'M-1', { ref: '502' }), jr('2026-10-30', 15000, 'M-2')], 'j'),
    balances: [],
  }
}

test('journal entries before the first statement are assumed cleared unless they match it', () => {
  const ds = tiny()
  ds.bank = ds.bank.filter(b => b.date >= '2026-10-01')
  const oct = reconcileAll(ds, cfg()).get('2026-10')!
  assert.deepEqual(oct.assumedCleared.map(e => e.id), ['j0', 'j1'])
  assert.ok(oct.matches.some(m => m.book.includes('j2')))
  assert.equal(oct.statement.source, 'assumed')
  assert.equal(oct.statement.opening, 80000)
  assert.ok(oct.tiesOut)
})

test('outstanding cheques carry forward and clear in the next month', () => {
  const recs = reconcileAll(tiny(), cfg({ statements: { '2026-09': { opening: 0, closing: 80000, source: 'manual' } } }))
  const sep = recs.get('2026-09')!, oct = recs.get('2026-10')!
  assert.deepEqual(sep.outstandingCheques.map(e => e.ref), ['502'])
  assert.equal(sep.adjustedBank, 50000)
  assert.equal(sep.journal, 50000)
  assert.ok(sep.tiesOut)
  assert.equal(oct.outstandingCheques.length, 0)
  assert.ok(oct.matches.some(m => m.book.includes('j2')))
  assert.equal(oct.statement.source, 'derived')
  assert.equal(oct.statement.closing, 50000)
  assert.deepEqual(oct.outstandingDeposits.map(e => e.amount), [15000])
  assert.equal(oct.adjustedBank, oct.journal)
})

test('the tie-out explains bank-only items and flags a statement that does not add up', () => {
  const ds = tiny()
  ds.bank.push({ ...bk('2026-09-30', -1500, 'MONTHLY SERVICE FEE'), id: 'fee', line: 9 })
  const sep = reconcileAll(ds, cfg({ statements: { '2026-09': { opening: 0, closing: 78500, source: 'manual' } } })).get('2026-09')!
  assert.equal(sep.bankOnlyTotal, -1500)
  assert.equal(sep.adjustedBank - sep.journal, -1500)
  assert.equal(sep.unexplainedBank, 0)
  assert.ok(sep.exceptions.some(e => e.kind === 'bankfee'))
  const gap = reconcileAll(tiny(), cfg({ statements: { '2026-09': { opening: 0, closing: 90000, source: 'manual' } } })).get('2026-09')!
  assert.equal(gap.statementGap, -10000)
  assert.ok(gap.exceptions.some(e => e.kind === 'statement-gap'))
  assert.ok(gap.exceptions.some(e => e.kind === 'unexplained'))
})

test('Transfer Funds with no matter: journal and client ledgers disagree by exactly that amount', () => {
  const ds = tiny()
  ds.book.push({ ...jr('2026-09-25', -10000, '', { kind: 'transfer', desc: 'Transfer Funds to operating' }), id: 'trf', line: 20 })
  ds.bank.push({ ...bk('2026-09-25', -10000, 'ONLINE TRANSFER TO OPERATING'), id: 'btrf', line: 20 })
  const sep = reconcileAll(ds, cfg({ statements: { '2026-09': { opening: 0, closing: 70000, source: 'manual' } } })).get('2026-09')!
  assert.equal(sep.adjustedBank, sep.journal)
  assert.equal(sep.clientTotal - sep.journal, 10000)
  assert.equal(sep.unallocatedTotal, -10000)
  assert.equal(sep.unexplainedClients, 0)
  const ex = sep.exceptions.find(e => e.kind === 'transfer')!
  assert.equal(ex.severity, 'critical')
  assert.deepEqual(ex.fix.map(f => [f.type, f.amount]), [['Reversal', 10000], ['Disbursement', -10000]])
})

test('a transfer to operating against a matter with an invoice number is fine; without one it is a warning', () => {
  const ds = tiny()
  ds.book.push({ ...jr('2026-09-25', -5000, 'M-1', { kind: 'transfer', desc: 'Fees to operating', ref: 'INV-1043' }), id: 'ok', line: 21 })
  ds.book.push({ ...jr('2026-09-26', -5000, 'M-1', { kind: 'transfer', desc: 'Fees to operating' }), id: 'bad', line: 22 })
  const sep = reconcileAll(ds, cfg()).get('2026-09')!
  const t = sep.exceptions.filter(e => e.kind === 'transfer')
  assert.equal(t.length, 1)
  assert.deepEqual(t[0].bookIds, ['bad'])
  assert.equal(t[0].severity, 'warning')
})

test('negative client balances are critical even when the account total is positive', () => {
  const ds = tiny()
  ds.book.push({ ...jr('2026-09-10', 2000, 'M-9'), id: 'd9', line: 30 }, { ...jr('2026-09-12', -2350, 'M-9', { ref: '777' }), id: 'c9', line: 31 })
  ds.bank.push({ ...bk('2026-09-10', 2000), id: 'bd9', line: 30 }, { ...bk('2026-09-16', -2350, 'CHEQUE 777', '777'), id: 'bc9', line: 31 })
  const sep = reconcileAll(ds, cfg()).get('2026-09')!
  const neg = sep.exceptions.find(e => e.kind === 'negative')!
  assert.equal(neg.matter, 'M-9')
  assert.equal(neg.amount, -350)
  assert.equal(neg.fix[0].amount, 350)
})

test('paying out before the deposit cleared is flagged even though the ledger never goes negative', () => {
  const ds: Dataset = {
    bank: ids([bk('2026-10-27', 6000000, 'BRANCH DEPOSIT'), bk('2026-10-23', -3900000, 'CHEQUE 1191', '1191')], 'b'),
    book: ids([jr('2026-10-20', 6000000, 'PI-44'), jr('2026-10-22', -3900000, 'PI-44', { ref: '1191' })], 'j'),
    balances: [],
  }
  const oct = reconcileAll(ds, cfg()).get('2026-10')!
  assert.ok(!oct.exceptions.some(e => e.kind === 'negative'))
  const u = oct.exceptions.find(e => e.kind === 'uncleared')!
  assert.equal(u.matter, 'PI-44')
  assert.equal(u.amount, -3900000)
})

test('duplicates, stale balances and stale-dated cheques are found', () => {
  const ds: Dataset = {
    bank: ids([bk('2026-03-01', 40000), bk('2026-10-09', 150000, 'ACH CREDIT')], 'b'),
    book: ids([
      jr('2026-10-09', 150000, 'PI-40', { ref: 'ACH-1' }), jr('2026-10-09', 150000, 'PI-40', { ref: 'ACH-1' }),
      jr('2025-06-01', 321240, 'ES-118', { kind: 'opening', desc: 'Opening balance' }),
      jr('2026-03-02', -40000, 'PI-40', { ref: '900', payee: 'Old payee' }), jr('2026-03-01', 40000, 'PI-40'),
    ], 'j'),
    balances: [{ matter: 'ES-118', client: 'Estate', balance: 321240, asOf: '2026-10-31', line: 2, lastActivity: '2025-06-01' }, { matter: 'PI-40', client: 'Okafor', balance: 300000, asOf: '2026-10-31', line: 3 }],
  }
  const oct = reconcileAll(ds, cfg()).get('2026-10')!
  const kinds = oct.exceptions.map(e => e.kind)
  assert.ok(kinds.includes('duplicate'))
  assert.ok(kinds.includes('stale'))
  assert.ok(kinds.includes('stale-cheque'))
  const dup = oct.exceptions.find(e => e.kind === 'duplicate')!
  assert.equal(dup.fix.length, 1)
  assert.equal(dup.fix[0].amount, -150000)
})

test('imported client ledger balances are compared with the journal per matter', () => {
  const ds = tiny()
  ds.balances = [{ matter: 'M-1', client: 'C', balance: 60000, asOf: '2026-09-30', line: 2 }]
  const sep = reconcileAll(ds, cfg()).get('2026-09')!
  assert.equal(sep.clientSource, 'imported')
  assert.equal(sep.clientTotal, 60000)
  assert.equal(sep.ledgerDiffTotal, -10000)
  assert.equal(sep.unexplainedClients, 0)
  assert.ok(sep.exceptions.some(e => e.kind === 'ledger-mismatch' && e.amount === -10000))
})

test('correcting entries CSV has funds in/out split and a reason per row', () => {
  const ds = tiny()
  ds.bank.push({ ...bk('2026-09-30', -1500, 'MONTHLY SERVICE FEE'), id: 'fee', line: 9 })
  const sep = reconcileAll(ds, cfg()).get('2026-09')!
  const rows = correctionRows(sep)
  assert.equal(rows[0][0], 'date')
  const fee = rows.filter(r => r[9] === 'Bank fee charged to the trust account')
  assert.equal(fee.length, 2)
  assert.deepEqual(fee.map(r => [r[5], r[6]]), [['15.00', ''], ['', '15.00']])
})

// ---------- Samples ----------

test('the clean sample ties out every month with its reconciling items explained', () => {
  const def = SAMPLES.find(s => s.id === 'marlowe')!
  const ds = generate(def)
  const recs = reconcileAll(ds, sampleConfig(def, ds))
  assert.equal(recs.size, 6)
  for (const r of recs.values()) {
    assert.ok(r.tiesOut, `${r.month} ties out`)
    assert.ok(!r.exceptions.some(e => e.severity === 'critical'), `${r.month} has no critical exceptions`)
  }
  const oct = recs.get('2026-10')!
  assert.equal(oct.outstandingDeposits.length, 1)
  assert.ok(oct.outstandingCheques.length >= 1)
  assert.ok(oct.matches.some(m => m.how === 'batch'))
})

test('the problem sample surfaces each scripted mistake exactly where it was planted', () => {
  const def = SAMPLES.find(s => s.id === 'reyes')!
  const ds = generate(def)
  const oct = reconcileAll(ds, sampleConfig(def, ds)).get('2026-10')!
  assert.ok(!oct.tiesOut)
  assert.equal(oct.unexplainedBank, 0)
  assert.equal(oct.unexplainedClients, 0)
  const has = (kind: string, matter?: string) => oct.exceptions.some(e => e.kind === kind && (!matter || e.matter === matter))
  assert.equal(oct.exceptions.find(e => e.kind === 'transfer' && e.bookIds.length)!.matter, 'PI-2026-040')
  assert.ok(has('negative', 'PI-2026-031'))
  assert.ok(has('uncleared', 'PI-2026-044'))
  assert.ok(has('bankfee'))
  assert.ok(has('duplicate', 'PI-2026-040'))
  assert.ok(has('stale', 'ES-2024-118'))
  assert.ok(oct.outstandingCheques.some(e => e.ref === '1192'))
  const bankOnlyTransfer = oct.exceptions.find(e => e.kind === 'transfer' && e.bankIds.length)!
  assert.equal(bankOnlyTransfer.matter, 'PI-2026-018')
})

test('exporting a sample as files and importing them again reproduces the same reconciliation', () => {
  const def = SAMPLES.find(s => s.id === 'reyes')!
  const ds = generate(def)
  const files = Object.values(sampleFiles(def, ds, '2026-10'))
  const parsed = files.map(f => { const csv = parseCsv(f); const d = detect(csv.rows); return { d, v: validate(d.kind!, csv, d.map, { hasHeader: d.hasHeader, asOf: '2026-10-31' }) } })
  assert.deepEqual(parsed.map(p => p.d.kind), ['bank', 'book', 'balances'])
  const re: Dataset = { bank: parsed[0].v.rows as BankLine[], book: parsed[1].v.rows as BookEntry[], balances: parsed[2].v.rows as never }
  const c = sampleConfig(def, ds)
  const a = reconcileAll(ds, c).get('2026-10')!
  const b = reconcileAll(re, { ...c, statements: { '2026-10': c.statements['2026-10'] } }).get('2026-10')!
  assert.equal(b.journal, a.journal)
  assert.equal(b.clientTotal, a.clientTotal)
  assert.equal(b.adjustedBank, a.adjustedBank)
  assert.deepEqual(b.exceptions.map(e => e.kind).sort(), a.exceptions.map(e => e.kind).sort())
})

// ---------- Snapshots, privacy and the compliance calendar ----------

test('totals-only cloud snapshots carry no client names, matters or payees', () => {
  const def = SAMPLES.find(s => s.id === 'reyes')!
  const ds = generate(def)
  const oct = reconcileAll(ds, sampleConfig(def, ds)).get('2026-10')!
  const snap = makeSnapshot(oct, 's1', 'USD')
  assert.ok(snap.clients!.length > 0)
  const cloud = JSON.stringify(cloudSnapshot(snap, true))
  for (const c of oct.clients) {
    assert.ok(!cloud.includes(c.matter), `matter ${c.matter} leaked`)
    if (c.client) assert.ok(!cloud.includes(c.client.split(',')[0]), `client ${c.client} leaked`)
  }
  assert.ok(!cloud.includes('Lindqvist'))
  assert.equal(cloudSnapshot(snap, true).totals.journal, oct.journal)
  assert.equal(cloudSnapshot(snap, false), snap)
})

test('compliance calendar marks signed, unsigned and overdue months with the Ontario 25-day deadline', () => {
  const snap = (month: string, signed: boolean) => ({ ...makeSnapshot(reconcileAll(tiny(), cfg()).get('2026-09')!, month, 'CAD'), month, ...(signed ? { signoff: { reconciler: 'A', reconciledAt: '2026-10-05' } } : {}) })
  const cal = complianceCalendar('2026-10', [snap('2026-08', true), snap('2026-09', false)], ['2026-07', '2026-08', '2026-09', '2026-10'], 'on', '2026-11-08')
  assert.equal(cal.length, 12)
  assert.equal(cal[0].month, '2025-11')
  const by = Object.fromEntries(cal.map(c => [c.month, c]))
  assert.equal(by['2026-08'].status, 'signed')
  assert.equal(by['2026-09'].status, 'reconciled')
  assert.equal(by['2026-09'].due, '2026-10-25')
  assert.ok(by['2026-09'].overdue)
  assert.equal(by['2026-07'].status, 'data')
  assert.ok(!by['2026-10'].overdue)
  assert.equal(dueDate('2026-10', 'az'), '2026-11-30')
})

// ---------- Real export layouts (src/engine/fixtures) ----------

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
const load = (name: string) => {
  const parsed = parseCsv(decodeText(fixture(name)))
  const d = detect(parsed.rows)
  const v = validate(d.kind!, dropPreamble(parsed, d.headerRow), d.map, { hasHeader: d.hasHeader })
  return { d, v, rows: v.rows as (BankLine & BookEntry)[], errors: v.issues.filter(i => i.level !== 'skip') }
}

test('Bank of America CSV: the summary block above the header and the beginning-balance row are skipped', () => {
  const { d, rows, errors, v } = load('bofa.csv')
  assert.equal(d.format, 'Bank of America CSV')
  assert.equal(d.headerRow, 5) // blank lines are dropped by parseCsv
  assert.deepEqual(rows.map(r => r.amount), [500000, -123515, -1500])
  assert.equal(rows[1].ref, '1042')
  assert.deepEqual(errors, [])
  assert.ok(v.issues.some(i => i.line === 8 && /Balance row/.test(i.message)))
  assert.deepEqual(statementsFromBalances(rows)['2026-10'], { opening: 1234567, closing: 1609552 })
})

test('QuickBooks Online transaction detail: title block, account group, totals and footer are skipped; Customer:Job is the ledger', () => {
  const { d, rows, errors } = load('qbo.csv')
  assert.equal(d.format, 'QuickBooks transaction detail')
  assert.deepEqual(errors, [])
  assert.equal(rows.length, 4)
  assert.equal(rows[0].matter, 'Smith, John:Estate Admin')
  assert.equal(rows[0].client, 'Smith, John')
  assert.equal(rows[1].ref, '1042')
  assert.deepEqual(rows.slice(2).map(r => [r.matter, r.kind]), [['', 'transfer'], ['', 'fee']])
})

test('QuickBooks Desktop layout (Type, Split) is read as a trust journal, not a bank statement', () => {
  const { d, rows, errors } = load('qbd.csv')
  assert.equal(d.kind, 'book')
  assert.deepEqual(errors, [])
  assert.deepEqual(rows.map(r => r.amount), [500000, -123515])
})

test('unsigned amounts with a Debit/Credit column (Capital One) come out signed', () => {
  const { rows } = load('capitalone.csv')
  assert.deepEqual(rows.map(r => r.amount), [500000, -123515, -1500])
  assert.equal(rows[0].date, '2026-10-02')
  // Chase amounts are already signed; its DEBIT/CHECK details column must not flip them again.
  const chase = load('chase.csv').rows
  assert.deepEqual(chase.map(r => r.amount), [250000, -41000, -150000, 300000])
  // Newest-first file: opening is the oldest balance less its amount.
  assert.deepEqual(statementsFromBalances(chase)['2026-10'], { opening: 632540, closing: 991540 })
})

test('headerless bank files: CIBC (4 columns), TD (5 columns) and Wells Fargo all read withdrawals as negative', () => {
  for (const f of ['cibc.csv', 'td.csv', 'wellsfargo.csv']) {
    const { d, rows } = load(f)
    assert.equal(d.hasHeader, false, f)
    assert.deepEqual(rows.map(r => r.amount), [500000, -123515, -1500], f)
    assert.equal(rows[1].ref, '1042', f)
  }
  const rbc = load('rbc.csv')
  assert.equal(rbc.d.format, 'RBC Royal Bank CSV')
  assert.equal(rbc.rows[0].desc, 'DEPOSIT IBB BRANCH')
})

test('real OFX 1.02 file (ofxparse fixture): full MEMO kept once, cheque number 0 ignored, ledger balance read', () => {
  const r = parseOfx(fixture('ofxparse-bank_medium.ofx').toString('latin1'))
  assert.equal(r.lines.length, 3)
  assert.equal(r.lines[0].desc, "POS MERCHANDISE;MCDONALD'S #112")
  assert.equal(r.lines[1].ref, '')
  assert.equal(r.lines[1].amount, -31667)
  assert.equal(r.closing, 38234)
  assert.equal(r.closingDate, '2009-05-23')
})

test('OFX entities are decoded and a file with several accounts is flagged', () => {
  const one = (n: number) => `<STMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>2026100${n}<TRNAMT>-10.00<NAME>SMITH &amp; JONES<MEMO>CHECK #1050</BANKTRANLIST></STMTRS>`
  const r = parseOfx(`OFXHEADER:100\n<OFX>${one(1)}${one(2)}</OFX>`)
  assert.equal(r.lines[0].desc, 'SMITH & JONES · CHECK #1050')
  assert.equal(r.lines[0].ref, '1050')
  assert.ok(r.issues.some(i => /2 accounts/.test(i.message)))
})

test('cheque numbers inside bank descriptions let cheques of equal amount match the right journal entry', () => {
  assert.equal(chequeIn('CHQ#01042-0123456'), '1042')
  assert.equal(chequeIn('CHECK # 319'), '319')
  assert.equal(chequeIn('REMOTE ONLINE DEPOSIT 12345'), '')
  const csv = parseCsv('03/11/2026,CHEQUE 2213,500.00,,\n03/11/2026,CHEQUE 2212,500.00,,\n03/12/2026,DEPOSIT,,10.00,\n')
  const bank = validate('bank', csv, detect(csv.rows).map, { hasHeader: false }).rows as BankLine[]
  const book = ids([jr('2026-03-02', -50000, 'A', { ref: '2212' }), jr('2026-03-03', -50000, 'B', { ref: '2213' })], 'j')
  const res = matchItems(bank, book, S)
  const pair = Object.fromEntries(res.matches.map(m => [bank.find(b => b.id === m.bank[0])!.ref, book.find(e => e.id === m.book[0])!.ref]))
  assert.deepEqual(pair, { 2212: '2212', 2213: '2213' })
})

test('files that are not valid UTF-8 are read as Windows-1252', () => {
  assert.equal(decodeText(new Uint8Array([0x44, 0xe9, 0x70, 0xf4, 0x74])), 'Dépôt')
  assert.equal(decodeText(new TextEncoder().encode('Dépôt')), 'Dépôt')
})

test('credit-union "dividend" credits on the statement are treated as trust interest', () => {
  const ds: Dataset = { bank: assignBankIds([bk('2026-10-31', 412, 'DIVIDEND EARNED FOR PERIOD')]), book: [], balances: [] }
  const r = reconcileAll(ds, cfg()).get('2026-10')!
  assert.deepEqual(r.exceptions.map(e => e.kind), ['interest'])
})

test('due dates: Ontario 25 days, BC 30 days after month end (across February), others end of next month', () => {
  assert.equal(dueDate('2026-01', 'bc'), '2026-03-02')
  assert.equal(dueDate('2026-01', 'on'), '2026-02-25')
  assert.equal(dueDate('2026-01', 'fl'), '2026-02-28')
})

test('a bank fee recorded in the journal with no ledger is matched but still reported, with a firm-funds fix', () => {
  const bank = assignBankIds([bk('2026-10-31', -1500, 'MONTHLY SERVICE FEE')])
  const book = ids([jr('2026-10-31', -1500, '', { desc: 'Monthly service fee', kind: 'fee' })], 'j')
  const r = reconcileAll({ bank, book, balances: [] }, cfg({ statements: { '2026-10': { opening: 1500, closing: 0, source: 'manual' } } })).get('2026-10')!
  assert.equal(r.matches.length, 1)
  const fee = r.exceptions.find(e => e.kind === 'bankfee')!
  assert.ok(fee)
  // Applying the fix leaves the account-level total at zero and puts the net cost on the firm ledger.
  assert.equal(fee.fix.filter(f => !f.matter).reduce((a, f) => a + f.amount, 0) + -1500, 0)
  assert.equal(fee.fix.filter(f => f.matter === 'FIRM-BANK-CHARGES').reduce((a, f) => a + f.amount, 0), 0)
})

// ---------- OFX with several accounts ----------

const accountsOf = (name: string) => parseOfxAccounts(fixture(name).toString('latin1'))

test('OFX SGML file with two accounts: each account keeps its own lines, balance and label', () => {
  const [trust, operating] = accountsOf('two-accounts-sgml.ofx')
  assert.deepEqual([trust.index, operating.index], [0, 1])
  assert.deepEqual([trust.kind, trust.type, trust.last4, trust.currency], ['bank', 'CHECKING', '0042', 'USD'])
  assert.deepEqual([operating.kind, operating.type, operating.last4], ['bank', 'CHECKING', '0077'])
  assert.deepEqual(trust.lines.map(l => l.amount), [250000, -41000, -150000, 300000])
  assert.deepEqual(operating.lines.map(l => l.amount), [820000, -315000, 150000, -74218])
  assert.equal(trust.closing, 990000)
  assert.equal(operating.closing, 4125077)
  assert.equal(trust.closingDate, '2026-10-31')
  assert.equal(trust.lines[1].ref, '1043')
  assert.equal(trust.lines.some(l => /LEASE|PAYROLL/.test(l.desc)), false)
  assert.equal(operating.lines.some(l => /CHECK 1043|DEPOSIT ID/.test(l.desc)), false)
  assert.deepEqual([trust.issues, operating.issues], [[], []])
  assert.equal(ofxAccountLabel(trust), 'Checking account ending 0042')
})

test('OFX accounts that reuse the same FITIDs, or even identical rows, neither collide nor deduplicate each other', () => {
  const text = fixture('two-accounts-sgml.ofx').toString('latin1')
  const fitids = [...text.matchAll(/<FITID>(\d+)/g)].map(m => m[1])
  assert.equal(fitids.length, 8)
  assert.equal(new Set(fitids).size, 4, 'the fixture reuses every FITID in both accounts')
  const [a, b] = parseOfxAccounts(text)
  assert.equal(a.lines.length, 4)
  assert.equal(b.lines.length, 4)
  // Two accounts holding identical transactions still each keep all of theirs, with distinct ids inside the account.
  const same = (acct: string) => `<STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>1<ACCTID>${acct}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-10.00<FITID>77<NAME>FEE</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-10.00<FITID>77<NAME>FEE</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>80.00<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS>`
  const [x, y] = parseOfxAccounts(`OFXHEADER:100\n<OFX><BANKMSGSRSV1>${same('1111')}${same('2222')}</BANKMSGSRSV1></OFX>`)
  for (const acct of [x, y]) {
    assert.equal(acct.lines.length, 2)
    assert.equal(new Set(acct.lines.map(l => l.id)).size, 2)
  }
  assert.deepEqual([x.last4, y.last4], ['1111', '2222'])
  assert.equal(parseOfx(`OFXHEADER:100\n<OFX><BANKMSGSRSV1>${same('1111')}${same('2222')}</BANKMSGSRSV1></OFX>`).lines.length, 4)
})

test('OFX 2.x XML file: indented elements, another account in BANKACCTTO ignored, account with a balance and no transactions', () => {
  const [checking, savings] = accountsOf('two-accounts-xml.ofx')
  assert.deepEqual([checking.type, checking.last4, checking.currency], ['CHECKING', '0042', 'CAD'])
  assert.deepEqual(checking.lines.map(l => [l.date, l.amount, l.ref]), [['2026-10-05', 400000, ''], ['2026-10-14', -125050, '2210']])
  assert.equal(checking.lines[0].desc, 'E-TRANSFER DEPOSIT · Retainer, synthetic client')
  assert.equal(checking.closing, 274950)
  assert.equal(checking.closingDate, '2026-10-31')
  assert.equal(checking.issues.length, 0)
  assert.deepEqual([savings.type, savings.last4], ['SAVINGS', '0177'])
  assert.deepEqual(savings.lines, [])
  assert.equal(savings.closing, 125000)
  assert.equal(savings.closingDate, '2026-10-31')
  assert.deepEqual(savings.issues, [], 'a balance without activity is a valid statement')
})

test('a truncated OFX statement reports line-numbered problems and does not take in the next account', () => {
  const file = [
    'OFXHEADER:100',                                                                  // 1
    '<OFX><BANKMSGSRSV1>',                                                            // 2
    '<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>5550001111<ACCTTYPE>CHECKING</BANKACCTFROM>', // 3
    '<BANKTRANLIST>',                                                                 // 4
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001<TRNAMT>100.00<FITID>1<NAME>FIRST</STMTTRN>', // 5
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002',                                      // 6 (cut off here)
    '<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>5550002222<ACCTTYPE>CHECKING</BANKACCTFROM>', // 7
    '<BANKTRANLIST>',                                                                 // 8
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261003<TRNAMT>7.00<FITID>2<NAME>SECOND</STMTTRN>',  // 9
    '</BANKTRANLIST><LEDGERBAL><BALAMT>7.00<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS>', // 10
    '</BANKMSGSRSV1></OFX>',
  ].join('\n')
  const [a, b] = parseOfxAccounts(file)
  assert.deepEqual(a.lines.map(l => l.desc), ['FIRST'])
  assert.equal(a.closing, undefined)
  assert.equal(a.skipped, 1)
  assert.deepEqual(a.issues.map(i => i.line).sort(), [3, 6])
  assert.ok(a.issues.some(i => i.line === 6 && /no valid TRNAMT/.test(i.message)))
  assert.ok(a.issues.some(i => i.line === 3 && /ending 1111 is not closed/.test(i.message)))
  assert.deepEqual(b.lines.map(l => [l.desc, l.amount, l.line]), [['SECOND', 700, 9]])
  assert.equal(b.closing, 700)
  assert.deepEqual(b.issues, [])
  // A statement that ends at the end of the file is cut off too, and its complete rows are kept.
  const [only] = parseOfxAccounts(file.split('\n').slice(0, 5).join('\n'))
  assert.equal(only.lines.length, 1)
  assert.equal(only.issues.length, 1)
  assert.equal(only.issues[0].line, 3)
})

test('a transaction cut off mid-amount is reported and never imported with a partial amount', () => {
  const acct = (id: string, rows: string) => `<STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>${id}</BANKACCTFROM><BANKTRANLIST>\n${rows}`
  const whole = '<STMTTRN><DTPOSTED>20261001<TRNAMT>-50.00<NAME>WHOLE</STMTTRN>\n'
  const cut = '<STMTTRN><DTPOSTED>20261002<TRNAMT>-12'
  const head = 'OFXHEADER:100\n<OFX><BANKMSGSRSV1>'
  const next = acct('9999', '<STMTTRN><DTPOSTED>20261003<TRNAMT>7.00<NAME>NEXT</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>')
  for (const text of [head + acct('1111', whole + cut), head + acct('1111', whole + cut + '\n' + next), head + whole + cut]) {
    const [a, b] = parseOfxAccounts(text)
    assert.deepEqual(a.lines.map(l => [l.desc, l.amount]), [['WHOLE', -5000]])
    assert.equal(a.skipped, 1)
    assert.ok(a.issues.some(i => /cut off and was not imported/.test(i.message) && text.split('\n')[i.line - 1].includes('<TRNAMT>-12')))
    if (b) assert.deepEqual(b.lines.map(l => [l.desc, l.amount]), [['NEXT', 700]])
  }
  // A file that is not OFX keeps its own message.
  assert.match(parseOfxAccounts('not an ofx file')[0].issues[0].message, /No <STMTTRN> transactions found/)
  // An unclosed last row inside a closed statement is complete, so it is kept.
  assert.equal(parseOfxAccounts(head + acct('1111', whole + '<STMTTRN><DTPOSTED>20261002<TRNAMT>-12.00</STMTRS></OFX>'))[0].lines.length, 2)
})

test('OFX credit card statements are told apart from bank accounts, and only the last four characters of an account id are kept', () => {
  const card = `<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>4111222233334411</CCACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-42.00<FITID>9<NAME>COFFEE</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-42.00<DTASOF>20261031</LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>`
  const text = `OFXHEADER:100\n<OFX>${fixture('two-accounts-sgml.ofx').toString('latin1').match(/<BANKMSGSRSV1>[\s\S]*<\/BANKMSGSRSV1>/)![0]}${card}</OFX>`
  const accounts = parseOfxAccounts(text)
  assert.deepEqual(accounts.map(a => a.kind), ['bank', 'bank', 'creditcard'])
  assert.equal(accounts[2].last4, '4411')
  assert.equal(accounts[2].type, '')
  assert.equal(ofxAccountLabel(accounts[2]), 'Credit card ending 4411')
  assert.deepEqual(accounts.map(a => a.lines.length), [4, 4, 1])
  const dump = JSON.stringify(accounts) + accounts.map(ofxAccountLabel).join()
  for (const full of ['000912340042', '000912340077', '4111222233334411', '123456789']) assert.equal(dump.includes(full), false, `${full} must not be kept`)
  assert.equal(ofxAccountLabel({ index: 1, kind: 'bank', type: '', last4: '' }), 'Bank account 2 (no account number in the file)')
})

test('single-account OFX results are the same as before: parseOfx equals the one account, and an empty download is still flagged', () => {
  const text = fixture('ofxparse-bank_medium.ofx').toString('latin1')
  const accounts = parseOfxAccounts(text)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].last4, '5678')
  assert.equal(accounts[0].type, 'CHECKING')
  assert.deepEqual(parseOfx(text), { lines: accounts[0].lines, closing: 38234, closingDate: '2009-05-23', issues: [] })
  const junk = parseOfx('OFXHEADER:100\n<OFX></OFX>')
  assert.deepEqual(junk.issues, [{ line: 1, message: 'No <STMTTRN> transactions found. Is this an OFX/QFX statement download?' }])
  assert.equal(parseOfxAccounts('not ofx at all').length, 1)
})
