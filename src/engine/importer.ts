import { parseDate, parseMoney } from './dates.ts'
import type { BankLine, BookEntry, BookKind, LedgerBalance } from './types.ts'

/** UTF-8 when the bytes are valid UTF-8, otherwise Windows-1252 (older bank and OFX exports with accented names). */
export function decodeText(bytes: ArrayBuffer | Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return new TextDecoder('windows-1252').decode(bytes) }
}

/** RFC 4180 CSV (quotes, escaped quotes, CRLF, newlines in quotes). Also returns the line each record starts on. */
export function parseCsv(text: string): { rows: string[][]; lines: number[] } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const delim = sniffDelimiter(text)
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else {
        if (c === '\n') line++
        field += c
      }
      continue
    }
    if (c === '"' && field.trim() === '') { quoted = true; field = '' }
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim() !== '')) { rows.push(row); lines.push(rowLine) }
      row = []
      line++
      rowLine = line
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.some(f => f.trim() !== '')) { rows.push(row); lines.push(rowLine) }
  }
  return { rows, lines }
}

function sniffDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n')
  const counts = [',', '\t', ';', '|'].map(d => [d, head.split(d).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(v => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}

// ---------- OFX / QFX ----------

export interface OfxResult { lines: BankLine[]; closing?: number; closingDate?: string; issues: Issue[] }

/**
 * One statement response of an OFX file: a bank statement (`STMTRS`, with `BANKACCTFROM`) or a credit card
 * statement (`CCSTMTRS`, with `CCACCTFROM`). Sections 11.3 and 11.4 of the OFX specification define both.
 * Everything here belongs to this statement only: lines, ledger balance and problems never mix with another account's.
 */
export interface OfxAccount extends OfxResult {
  /** Position of the statement in the file, from 0. */
  index: number
  kind: 'bank' | 'creditcard'
  /** `ACCTTYPE` of a bank account (CHECKING, SAVINGS, MONEYMRKT, CREDITLINE, CD); empty for cards or when the file omits it. */
  type: string
  /** Last four characters of `ACCTID`. The full account number is not kept. */
  last4: string
  currency: string
  /** Line the statement starts on. */
  line: number
  /** Transactions dropped because they were unreadable. */
  skipped: number
}

const OFX_TYPES: Record<string, string> = { CHECKING: 'Checking', SAVINGS: 'Savings', MONEYMRKT: 'Money market', CREDITLINE: 'Credit line', CD: 'Certificate of deposit' }

/** "Checking account ending 0042": all a person needs to tell accounts apart, and never more than the last four characters. */
export function ofxAccountLabel(a: Pick<OfxAccount, 'index' | 'kind' | 'type' | 'last4'>): string {
  const what = a.kind === 'creditcard' ? 'Credit card' : OFX_TYPES[a.type] ? `${OFX_TYPES[a.type]} account` : 'Bank account'
  return a.last4 ? `${what} ending ${a.last4}` : `${what} ${a.index + 1} (no account number in the file)`
}

// A statement runs to its own closing tag, or stops where the next statement or message set starts, so a block
// that is cut off cannot take in the next account's rows.
const STATEMENT = /<(STMTRS|CCSTMTRS)>([\s\S]*?)(?=<\/\1>|<(?:STMTRS|CCSTMTRS|STMTTRNRS|CCSTMTTRNRS)>|<\/(?:BANKMSGSRSV1|CREDITCARDMSGSRSV1|OFX)>|$)/gi

/** Values of an OFX element: SGML (`<NAME>value`, no closing tag) and XML (`<NAME>value</NAME>`, possibly on its own line). */
const ofxTag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i'))
  return m ? decodeEntities(m[1].trim()) : ''
}

/**
 * Parses OFX 1.x (SGML, unclosed tags) and OFX 2.x (XML), one result per statement in file order.
 * QFX is OFX with an Intuit header. A file without statement wrappers is read as a single bank statement.
 */
export function parseOfxAccounts(text: string): OfxAccount[] {
  const newlines: number[] = []
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) newlines.push(i)
  const lineAt = (pos: number) => {
    let lo = 0, hi = newlines.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (newlines[mid] < pos) lo = mid + 1; else hi = mid }
    return lo + 1
  }
  const found = [...text.matchAll(STATEMENT)]
  const blocks = found.length
    ? found.map(m => {
      const name = m[1].toUpperCase()
      const end = m.index + m[0].length
      return { kind: name === 'CCSTMTRS' ? 'creditcard' as const : 'bank' as const, start: m.index, body: m[2], bodyAt: m.index + name.length + 2, closeTag: `</${name}>`, closed: text.slice(end, end + name.length + 3).toUpperCase() === `</${name}>` }
    })
    : [{ kind: 'bank' as const, start: 0, body: text, bodyAt: 0, closeTag: '</OFX>', closed: /<\/OFX>/i.test(text) }]

  return blocks.map((blk, index) => {
    const issues: Issue[] = []
    const lines: BankLine[] = []
    let skipped = 0
    const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|$)/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(blk.body))) {
      const b = m[1]
      const lineNo = lineAt(blk.bodyAt + m.index)
      const date = parseDate(ofxTag(b, 'DTPOSTED'))
      const amount = parseMoney(ofxTag(b, 'TRNAMT'))
      if (!date) { issues.push({ line: lineNo, message: `Transaction has no valid DTPOSTED ("${ofxTag(b, 'DTPOSTED')}")` }); skipped++; continue }
      if (Number.isNaN(amount)) { issues.push({ line: lineNo, message: `Transaction has no valid TRNAMT ("${ofxTag(b, 'TRNAMT')}")` }); skipped++; continue }
      // Cut off mid-transaction: the amount may be a fragment ("-12" of "-1234.00"), so it cannot be trusted.
      if (!blk.closed && re.lastIndex === blk.body.length) { issues.push({ line: lineNo, message: 'Transaction is cut off and was not imported' }); skipped++; continue }
      const name = ofxTag(b, 'NAME'), memo = ofxTag(b, 'MEMO')
      // NAME is capped at 32 characters, so banks often repeat it in full in MEMO.
      const desc = (memo && name && memo.toLowerCase().includes(name.toLowerCase()) ? memo : [name, memo].filter(Boolean).join(' · ')) || ofxTag(b, 'TRNTYPE')
      const ref = [ofxTag(b, 'CHECKNUM'), ofxTag(b, 'REFNUM')].find(r => r && !/^0+$/.test(r)) ?? (amount < 0 ? chequeIn(desc) : '')
      lines.push({ id: '', line: lineNo, date, amount, ref, desc })
    }
    // Only this statement's own account block (a transaction can carry another account in BANKACCTTO).
    const from = blk.body.match(/<(BANKACCTFROM|CCACCTFROM)>([\s\S]*?)(?=<\/\1>|<BANKTRANLIST>|<LEDGERBAL>|$)/i)?.[2] ?? ''
    const last4 = ofxTag(from, 'ACCTID').replace(/\s+/g, '').slice(-4)
    const ledger = blk.body.match(/<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|$)/i)
    let closing: number | undefined
    let closingDate: string | undefined
    if (ledger) {
      const v = parseMoney(ofxTag(ledger[1], 'BALAMT'))
      if (!Number.isNaN(v)) closing = v
      closingDate = parseDate(ofxTag(ledger[1], 'DTASOF')) ?? undefined
    }
    const line = lineAt(blk.start)
    const who = last4 ? `account ending ${last4}` : `account ${index + 1}`
    if (!blk.closed && found.length) issues.push({ line, message: `The statement for ${who} is not closed (no ${blk.closeTag}), so the file may be cut off. Check its transactions and balance.` })
    // An account with a balance and no activity is a valid statement.
    if (!lines.length && !issues.length && closing === undefined) issues.push({ line, message: 'No <STMTTRN> transactions found. Is this an OFX/QFX statement download?' })
    return { index, kind: blk.kind, type: blk.kind === 'bank' ? ofxTag(from, 'ACCTTYPE').toUpperCase() : '', last4, currency: ofxTag(blk.body, 'CURDEF').toUpperCase(), line, skipped, lines: withIds(lines, bankKey), closing, closingDate, issues }
  })
}

/**
 * The whole file as one result. Several accounts are combined and flagged, so this is only for callers that
 * cannot ask which account to use; the importer reads each account on its own with {@link parseOfxAccounts}.
 */
export function parseOfx(text: string): OfxResult {
  const accounts = parseOfxAccounts(text)
  if (accounts.length === 1) { const { lines, closing, closingDate, issues } = accounts[0]; return { lines, closing, closingDate, issues } }
  const issues = accounts.flatMap(a => a.issues)
  issues.push({ line: 1, message: `This file holds ${accounts.length} accounts; their transactions were combined. Download the trust account on its own.` })
  return { lines: withIds(accounts.flatMap(a => a.lines), bankKey), closing: accounts[0].closing, closingDate: accounts[0].closingDate, issues }
}

const decodeEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+);/g, (_, e: string) =>
  e[0] === '#' ? String.fromCharCode(+e.slice(1)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[e])

export const isOfx = (text: string) => /<OFX>|OFXHEADER/i.test(text.slice(0, 2000))

// ---------- Kinds, fields, formats ----------

export type Kind = 'bank' | 'book' | 'balances'
type FieldType = 'date' | 'money' | 'str'
export interface FieldSpec { key: string; label: string; required?: boolean; type: FieldType; aliases: string[]; hint?: string }

const F = (key: string, label: string, type: FieldType, aliases: string[], required = false, hint?: string): FieldSpec => ({ key, label, type, aliases, required, hint })

export const KINDS: Record<Kind, { title: string; short: string; fields: FieldSpec[] }> = {
  bank: {
    title: 'Trust bank statement',
    short: 'Bank',
    fields: [
      F('date', 'Date', 'date', ['date', 'posting_date', 'transaction_date', 'posted_date', 'trans_date', 'value_date', 'date_posted'], true),
      F('amount', 'Amount (signed)', 'money', ['amount', 'transaction_amount', 'cad$', 'usd$', 'amount_(cad)', 'amount_(usd)', 'net_amount'], false, 'Or map Withdrawal and Deposit below'),
      F('out', 'Withdrawal / debit', 'money', ['withdrawal', 'withdrawals', 'debit', 'debits', 'withdrawal_amount', 'debit_amount', 'money_out', 'paid_out']),
      F('in', 'Deposit / credit', 'money', ['deposit', 'deposits', 'credit', 'credits', 'deposit_amount', 'credit_amount', 'money_in', 'paid_in']),
      F('desc', 'Description', 'str', ['description', 'details', 'memo', 'payee', 'description_1', 'transaction_description', 'narrative', 'name']),
      F('desc2', 'Description 2', 'str', ['description_2', 'memo_2', 'additional_info']),
      F('ref', 'Cheque / reference no.', 'str', ['check_or_slip_#', 'check_number', 'cheque_number', 'check_#', 'cheque_#', 'check', 'cheque', 'reference', 'ref', 'reference_number', 'num', 'serial_number']),
      F('balance', 'Running balance', 'money', ['balance', 'running_bal.', 'running_balance', 'running_bal', 'ledger_balance']),
      F('drcr', 'Debit / credit indicator', 'str', ['transaction_type', 'details', 'debit/credit', 'credit/debit', 'dr/cr', 'cr/dr', 'type'], false, 'For files whose amounts are all positive'),
    ],
  },
  book: {
    title: 'Trust journal',
    short: 'Journal',
    fields: [
      F('date', 'Date', 'date', ['date', 'transaction_date', 'entry_date', 'posted', 'date_posted'], true),
      F('amount', 'Amount (signed)', 'money', ['amount', 'net', 'net_amount'], false, 'Or map Funds in and Funds out below'),
      F('in', 'Funds in', 'money', ['funds_in', 'deposit', 'deposits', 'receipts', 'credit', 'received', 'money_in']),
      F('out', 'Funds out', 'money', ['funds_out', 'withdrawal', 'withdrawals', 'disbursements', 'payments', 'debit', 'paid', 'money_out']),
      F('matter', 'Matter', 'str', ['matter', 'matter_number', 'matter_name', 'file', 'file_number', 'customer:job', 'class', 'job', 'case']),
      F('client', 'Client', 'str', ['client', 'client_name', 'contact', 'name', 'customer']),
      F('desc', 'Description', 'str', ['description', 'memo', 'memo/description', 'details', 'narrative', 'note']),
      F('ref', 'Reference / cheque no.', 'str', ['reference', 'ref', 'num', 'no.', 'check_number', 'cheque_number', 'check_#', 'cheque_#', 'reference_number']),
      F('payee', 'Payer / payee', 'str', ['payer/payee', 'payee', 'payer', 'source/destination', 'source/recipient', 'recipient', 'paid_to']),
      F('type', 'Transaction type', 'str', ['type', 'transaction_type', 'trans_type', 'category', 'split']),
    ],
  },
  balances: {
    title: 'Client ledger balances',
    short: 'Ledgers',
    fields: [
      F('matter', 'Matter', 'str', ['matter', 'matter_number', 'matter_name', 'file', 'file_number', 'customer:job', 'job', 'case'], true),
      F('client', 'Client', 'str', ['client', 'client_name', 'contact', 'name', 'customer']),
      F('balance', 'Trust balance', 'money', ['trust_balance', 'balance', 'trust_funds', 'funds_in_trust', 'available_balance', 'closing_balance', 'amount', 'total'], true),
      F('asOf', 'As of date', 'date', ['as_of', 'as_of_date', 'date', 'balance_date', 'period_end']),
      F('last', 'Last activity', 'date', ['last_activity', 'last_transaction', 'last_transaction_date', 'last_activity_date']),
    ],
  },
}

/** Named source formats we recognise from their header row. */
export interface Format { id: string; kind: Kind; label: string; test(hs: Set<string>, headers: string[]): boolean }
export const FORMATS: Format[] = [
  { id: 'clio-trust-ledger', kind: 'book', label: 'Clio Manage trust ledger report', test: h => h.has('funds_in') && h.has('funds_out') && h.has('matter') },
  { id: 'clio-trust-listing', kind: 'balances', label: 'Clio Manage trust listing report', test: h => (h.has('trust_balance') || h.has('trust_funds')) && (h.has('matter') || h.has('client')) },
  { id: 'quickbooks', kind: 'book', label: 'QuickBooks transaction detail', test: h => ((h.has('transaction_type') && h.has('num')) || ((h.has('transaction_type') || h.has('type')) && h.has('split'))) && h.has('amount') },
  { id: 'chase', kind: 'bank', label: 'Chase activity CSV', test: h => h.has('posting_date') && h.has('details') && h.has('check_or_slip_#') },
  { id: 'bofa', kind: 'bank', label: 'Bank of America CSV', test: h => h.has('running_bal.') },
  { id: 'rbc', kind: 'bank', label: 'RBC Royal Bank CSV', test: h => h.has('cheque_number') && h.has('description_1') && (h.has('cad$') || h.has('usd$')) },
  { id: 'headerless-5', kind: 'bank', label: 'Wells Fargo / TD style (no header row)', test: (_, raw) => raw.length >= 3 && !!parseDate(raw[0]) },
]

export const norm = (h: string) => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/\s+/g, '_')

export type Mapping = Record<string, number>

export function autoMap(kind: Kind, headers: string[]): Mapping {
  const hs = headers.map(norm)
  const map: Mapping = {}
  const used = new Set<number>()
  for (const f of KINDS[kind].fields) {
    const i = f.aliases.map(a => hs.indexOf(a)).find(i => i >= 0 && !used.has(i))
    if (i !== undefined) { map[f.key] = i; used.add(i) }
  }
  return map
}

/** For files without a header row we look at the values instead. */
function headerlessMap(rows: string[][]): Mapping {
  const sample = rows[0]
  const map: Mapping = { date: 0 }
  const money = sample.map((v, i) => [i, parseMoney(v)] as const).filter(([i, v]) => i > 0 && !Number.isNaN(v) && /\d/.test(sample[i]))
  const text = sample.map((v, i) => [i, v] as const).filter(([i, v]) => i > 0 && /[a-z]{3}/i.test(v) && Number.isNaN(parseMoney(v)))
  // Wells Fargo: date, amount, *, (cheque), description. TD: date, description, withdrawal, deposit, balance.
  if (sample.length === 5 && /^\*$/.test(sample[2].trim())) { map.amount = 1; map.ref = 3; map.desc = 4; return map }
  if (text.length) map.desc = text[0][0]
  // TD and CIBC: date, description, withdrawal, deposit (, balance). Exactly one of the two is filled on each row.
  const split = map.desc === 1 && sample.length >= 4 && rows.every(r => r.length >= 4 && [r[2], r[3]].filter(v => v.trim() !== '' && !Number.isNaN(parseMoney(v))).length === 1)
  if (split) { map.out = 2; map.in = 3; if (sample.length >= 5) map.balance = 4; return map }
  if (money.length) map.amount = money[0][0]
  return map
}

export interface Detection { kind: Kind | null; format: string; hasHeader: boolean; map: Mapping; headerRow: number }

/** Finds the header row: QuickBooks reports and Bank of America exports put a title or summary block above it. */
export function detect(rows: string[][]): Detection {
  // Callers drop rows before headerRow (see dropPreamble) so the header is always row 0 when validating.
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const d = detectAt(rows.slice(i))
    if (d.kind) return { ...d, headerRow: i }
  }
  return { ...detectAt(rows), headerRow: 0 }
}

/** Removes the title/summary block above the header row, keeping original line numbers. */
export const dropPreamble = (csv: { rows: string[][]; lines: number[] }, headerRow: number) => ({ rows: csv.rows.slice(headerRow), lines: csv.lines.slice(headerRow) })

function detectAt(rows: string[][]): Omit<Detection, 'headerRow'> {
  const headers = rows[0] ?? []
  const hs = new Set(headers.map(norm))
  const fmt = FORMATS.find(f => f.test(hs, headers))
  if (fmt?.id === 'headerless-5') return { kind: 'bank', format: fmt.label, hasHeader: false, map: headerlessMap(rows.slice(0, 30)) }
  if (fmt) return { kind: fmt.kind, format: fmt.label, hasHeader: true, map: autoMap(fmt.kind, headers) }
  let best: Kind | null = null
  let bestScore = 0
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const map = autoMap(kind, headers)
    if (!KINDS[kind].fields.every(f => !f.required || f.key in map)) continue
    if (kind !== 'balances' && !('amount' in map || 'in' in map || 'out' in map)) continue
    let score = Object.keys(map).length
    if (kind === 'book' && 'matter' in map) score += 3
    if (kind === 'bank' && !('matter' in autoMap('book', headers))) score += 1
    if (kind === 'balances' && ('in' in autoMap('book', headers) || 'date' in map)) score -= 3
    if (score > bestScore) { best = kind; bestScore = score }
  }
  return { kind: best, format: best ? 'Generic CSV' : 'Unknown', hasHeader: true, map: best ? autoMap(best, headers) : {} }
}

// ---------- Validation ----------

export interface Issue { line: number; message: string; level?: 'error' | 'skip' }
export interface Validated<T> { rows: T[]; issues: Issue[]; skipped: number; total: number }

const SUBTOTAL = /^(total|subtotal|closing balance|opening balance total|balance forward|grand total|totals?:)/i

export interface ValidateOpts { hasHeader: boolean; dayFirst?: boolean; asOf?: string }

/** Turns raw CSV records into typed rows, collecting a line-numbered report of every problem. */
export function validate(kind: Kind, csv: { rows: string[][]; lines: number[] }, map: Mapping, opts: ValidateOpts): Validated<BankLine | BookEntry | LedgerBalance> {
  const fields = KINDS[kind].fields
  const issues: Issue[] = []
  const start = opts.hasHeader ? 1 : 0
  const total = csv.rows.length - start
  for (const f of fields) if (f.required && !(f.key in map)) issues.push({ line: 1, message: `Required column "${f.label}" is not mapped` })
  if (kind !== 'balances' && !('amount' in map) && !('in' in map) && !('out' in map)) issues.push({ line: 1, message: 'Map either a signed Amount column, or the in/out columns' })
  if (issues.length) return { rows: [], issues, skipped: total, total }
  const get = (rec: string[], k: string) => map[k] === undefined ? '' : (rec[map[k]] ?? '').trim()
  const out: (BankLine | BookEntry | LedgerBalance)[] = []
  let skipped = 0
  // Clio groups the trust ledger by client: a row with only a name in the first column introduces the client.
  let groupClient = ''
  for (let r = start; r < csv.rows.length; r++) {
    const rec = csv.rows[r]
    const line = csv.lines[r]
    const joined = rec.join(' ').trim()
    if (SUBTOTAL.test(rec.find(c => c.trim())?.trim() ?? '')) { issues.push({ line, message: `Subtotal row skipped ("${joined.slice(0, 40)}")`, level: 'skip' }); skipped++; continue }
    if (kind === 'bank' && rec.some(c => BALANCE_ROW.test(c.trim()))) { issues.push({ line, message: `Balance row skipped ("${joined.slice(0, 40)}")`, level: 'skip' }); skipped++; continue }
    if (kind === 'balances') {
      const matter = get(rec, 'matter'), client = get(rec, 'client')
      const bal = parseMoney(get(rec, 'balance'))
      if (!matter && !client) { issues.push({ line, message: 'Matter is empty', level: 'skip' }); skipped++; continue }
      if (Number.isNaN(bal)) { issues.push({ line, message: `Balance "${get(rec, 'balance').slice(0, 30)}" is not an amount` }); skipped++; continue }
      const asOf = map.asOf !== undefined ? parseDate(get(rec, 'asOf'), opts.dayFirst) : null
      const last = map.last !== undefined ? parseDate(get(rec, 'last'), opts.dayFirst) : null
      out.push({ matter: matter || client, client, balance: bal, asOf: asOf ?? opts.asOf ?? '', line, ...(last ? { lastActivity: last } : {}) })
      continue
    }
    const rawDate = get(rec, 'date')
    const date = parseDate(rawDate, opts.dayFirst)
    if (!date) {
      const nonEmpty = rec.filter(c => c.trim())
      if (kind === 'book' && nonEmpty.length === 1 && map.client === undefined) { groupClient = nonEmpty[0].trim(); issues.push({ line, message: `Client heading "${groupClient.slice(0, 40)}" applied to the rows below`, level: 'skip' }); skipped++; continue }
      // Report titles, account group rows and footers ("Accrual Basis ...") have a single filled cell.
      if (nonEmpty.length === 1) { issues.push({ line, message: `Heading row skipped ("${nonEmpty[0].trim().slice(0, 40)}")`, level: 'skip' }); skipped++; continue }
      issues.push({ line, message: rawDate ? `Date "${rawDate.slice(0, 30)}" is not a date` : 'Date is empty' }); skipped++; continue
    }
    let amount: number
    if (map.amount !== undefined && get(rec, 'amount') !== '') amount = parseMoney(get(rec, 'amount'))
    else {
      const i = map.in !== undefined ? parseMoney(get(rec, 'in')) : NaN
      const o = map.out !== undefined ? parseMoney(get(rec, 'out')) : NaN
      amount = Number.isNaN(i) && Number.isNaN(o) ? NaN : (Number.isNaN(i) ? 0 : Math.abs(i)) - (Number.isNaN(o) ? 0 : Math.abs(o))
    }
    if (Number.isNaN(amount)) { issues.push({ line, message: `No amount on this row (${['amount', 'in', 'out'].filter(k => k in map).map(k => `"${get(rec, k)}"`).join(', ')})` }); skipped++; continue }
    if (amount === 0) { issues.push({ line, message: 'Zero amount skipped', level: 'skip' }); skipped++; continue }
    if (kind === 'bank') {
      const desc = [get(rec, 'desc'), get(rec, 'desc2')].filter(Boolean).join(' ')
      const bal = map.balance !== undefined ? parseMoney(get(rec, 'balance')) : NaN
      // Some banks (Capital One, many credit unions) export unsigned amounts with a Debit/Credit column.
      if (amount > 0 && map.amount !== undefined && DEBIT.test(get(rec, 'drcr'))) amount = -amount
      out.push({ id: '', line, date, amount, ref: cleanRef(get(rec, 'ref')) || (amount < 0 ? chequeIn(desc) : ''), desc, ...(Number.isNaN(bal) ? {} : { balance: bal }) })
    } else {
      const desc = get(rec, 'desc'), payee = get(rec, 'payee'), type = get(rec, 'type')
      let client = get(rec, 'client') || groupClient
      // Without a matter column each client (QuickBooks customer) is its own ledger.
      const matter = map.matter === undefined ? client : get(rec, 'matter')
      // QuickBooks "Customer:Job" names the ledger; the part before the colon is the client.
      if (matter.includes(':') && (!client || client === matter)) client = matter.split(':')[0].trim()
      const kindOf = classify(amount, `${type} ${desc} ${payee}`)
      out.push({ id: '', line, date, amount, matter, client, ref: cleanRef(get(rec, 'ref')), desc, payee, kind: kindOf })
    }
  }
  const rows = kind === 'bank' ? withIds(out as BankLine[], bankKey) : kind === 'book' ? withIds(out as BookEntry[], bookKey) : out
  return { rows, issues, skipped, total }
}

const DEBIT = /^(debit|dr|d|withdrawal|check|cheque|chq)$/i
const BALANCE_ROW = /^(beginning|ending|opening|closing|starting) balance\b|^balance (?:brought )?forward/i

/** Cheque number written into a bank description: "CHECK # 1042", "CHQ#01042-0123456", "Cheque 1042". */
export const chequeIn = (desc: string) => desc.match(/\b(?:chq|cheque|check|ck)\s*(?:no\.?|#)?\s*0*(\d{3,9})\b/i)?.[1] ?? ''

const cleanRef = (s: string) => s.replace(/^#|^(chq|cheque|check|ck)\s*#?/i, '').trim()

export const OPERATING = /operating|\bto op(?:erating)?\b|firm account|general account|transfer to (?:chk|checking)|fees? earned|legal fees? (?:to|transfer)/i

/** Classifies a journal entry from its type column and wording. */
export function classify(amount: number, text: string): BookKind {
  const t = text.toLowerCase()
  if (/opening balance|balance forward|brought forward/.test(t)) return 'opening'
  if (/interest/.test(t) && !/interest (?:on|in) (?:the )?(?:property|estate)/.test(t)) return 'interest'
  if (/bank (?:fee|charge)|service charge|monthly fee|wire fee|nsf fee|maintenance fee/.test(t)) return 'fee'
  if (/transfer/.test(t) || (amount < 0 && OPERATING.test(t))) return 'transfer'
  return amount > 0 ? 'deposit' : amount < 0 ? 'disbursement' : 'other'
}

// ---------- Stable ids ----------

const bankKey = (l: BankLine) => `b|${l.date}|${l.amount}|${l.ref}|${l.desc.toLowerCase().replace(/\s+/g, ' ')}`
const bookKey = (e: BookEntry) => `j|${e.date}|${e.amount}|${e.matter}|${e.ref}|${e.desc.toLowerCase().replace(/\s+/g, ' ')}`

function hash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519) }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}

/** Ids depend on content plus occurrence, so re-importing the same export yields the same ids. */
export function withIds<T extends { id: string }>(rows: T[], key: (r: T) => string): T[] {
  const seen = new Map<string, number>()
  return rows.map(r => {
    const k = key(r)
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return { ...r, id: hash(`${k}#${n}`) }
  })
}
export const assignBankIds = (rows: BankLine[]) => withIds(rows, bankKey)
export const assignBookIds = (rows: BookEntry[]) => withIds(rows, bookKey)

/** Opening and closing balances implied by a running-balance column, per month. */
export function statementsFromBalances(lines: BankLine[]): Record<string, { opening: number; closing: number }> {
  const out: Record<string, { opening: number; closing: number }> = {}
  const byMonth = new Map<string, BankLine[]>()
  for (const l of lines) if (l.balance !== undefined) { const m = l.date.slice(0, 7); byMonth.set(m, [...(byMonth.get(m) ?? []), l]) }
  for (const [m, ls] of byMonth) {
    // Exports list either oldest first or newest first; keep file order within a day.
    const sorted = [...ls].sort((a, b) => a.date.localeCompare(b.date) || (a.line - b.line))
    const descending = ls.length > 1 && ls[0].date > ls[ls.length - 1].date
    const ordered = descending ? [...ls].reverse() : sorted
    const first = ordered[0], last = ordered[ordered.length - 1]
    out[m] = { opening: first.balance! - first.amount, closing: last.balance! }
  }
  return out
}
