// All money is integer cents. Positive = money into trust, negative = money out.
export type Cents = number

/** One line of the trust bank statement. */
export interface BankLine {
  id: string
  line: number
  date: string // YYYY-MM-DD
  amount: Cents
  ref: string // cheque number or bank reference
  desc: string
  balance?: Cents // running balance after this line, when the export has one
}

export type BookKind = 'deposit' | 'disbursement' | 'transfer' | 'fee' | 'interest' | 'opening' | 'other'

/** One entry in the trust journal (Clio trust ledger, QuickBooks register, or a generic CSV). */
export interface BookEntry {
  id: string
  line: number
  date: string
  amount: Cents
  matter: string // empty when the entry was posted to the account but not to a client ledger
  client: string
  ref: string
  desc: string
  payee: string
  kind: BookKind
}

/** A client ledger balance as reported by the practice management system at a month end. */
export interface LedgerBalance {
  matter: string
  client: string
  balance: Cents
  asOf: string // YYYY-MM-DD month end the balance belongs to
  line: number
  lastActivity?: string
}

export interface Dataset {
  bank: BankLine[]
  book: BookEntry[]
  balances: LedgerBalance[]
}

export interface Statement {
  opening: Cents
  closing: Cents
  source: 'file' | 'manual'
}

export interface MatchSettings {
  /** Days a deposit or EFT may sit between the journal date and the bank date. */
  dateWindow: number
  /** Days a cheque may take to clear (matched by number and amount). */
  chequeWindow: number
  /** Most journal deposits that may make up one batched bank deposit. */
  batchMax: number
  /** Months without activity before a non-zero client balance counts as stale. */
  staleMonths: number
  /** Days after which an outstanding cheque is stale-dated. */
  staleChequeDays: number
}

export const DEFAULT_SETTINGS: MatchSettings = { dateWindow: 10, chequeWindow: 90, batchMax: 6, staleMonths: 12, staleChequeDays: 180 }

export interface ManualMatch { bank: string[]; book: string[] }

export type Jurisdiction = 'aba' | 'ca' | 'az' | 'fl' | 'on' | 'bc'

export interface Config {
  statements: Record<string, Statement>
  settings: MatchSettings
  manual: ManualMatch[]
  /** Auto-matches the user rejected, keyed by matchKey(). */
  rejected: string[]
  jurisdiction: Jurisdiction
  currency: 'USD' | 'CAD'
  accountName: string
}

export const EMPTY_DATASET: Dataset = { bank: [], book: [], balances: [] }
