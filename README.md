# Trust Reconcile

Monthly three-way trust account (IOLTA) reconciliation for small law firms. The bank statement, the trust journal and the client ledgers are tied out to the cent, every difference is explained, and the result prints as a signable report for the bar or law society auditor.

Live: https://trust-reconcile.vercel.app

## The pain

Trust accounting rules (ABA Model Rule 1.15 and its state versions, Law Society of Ontario By-Law 9, and others) expect a monthly comparison of three records of the same money. Solo lawyers and small-firm bookkeepers often skip it until something breaks. One lawyer found their practice software showing about $156,000 in trust while the bank showed $0: years of paying themselves with "Transfer Funds" instead of "Disburse Funds". A monthly three-way reconciliation catches that in the first month.

## Features

- Guided import of the bank statement (CSV from Chase, Bank of America, Wells Fargo, Capital One, RBC, TD, CIBC or any bank; OFX, QFX), the trust journal (Clio Manage trust ledger report, QuickBooks Online or Desktop transaction detail, any CSV) and client balances (Clio trust listing report or any CSV): header rows found below title and summary blocks, column mapping and a validation report with line numbers.
- Matching engine: cheque number + amount, amount + closest date, batched deposits (one bank line = several receipts), manual matches and rejections. Outstanding cheques and deposits in transit carry forward month to month.
- Three-way tie-out: adjusted bank = trust journal = sum of client ledgers, with each difference itemised.
- Findings: negative client balances, disbursements before the deposit cleared, transfers to operating with no matter or invoice (the Transfer vs Disburse mistake), dormant balances, bank fees and interest in trust, duplicates, stale cheques, statement gaps.
- Actions: printable monthly reconciliation with reconciler and reviewer sign-off, correcting journal entries as CSV, draft letters for dormant balances, a cleared-items worklist CSV.
- History: monthly snapshots, a compare view and a 12-month compliance calendar.
- Two synthetic sample firms (one clean, one with the classic mistakes).
- Local-first: everything runs in the browser and is stored in IndexedDB. Optional sign-in syncs across devices; "sync only totals, never client names" is on by default.

## Run locally

```
npm install
cp .env.example .env   # optional: Supabase URL and publishable key for sync
npm run dev
npm test               # engine tests (node --test), including fixtures in src/engine/fixtures
npm run build
```

Built with Vite, React and TypeScript. The reconciliation engine is plain TypeScript in `src/engine`.

## Known gaps

- Statement months are calendar months; banks whose statement period ends mid-month need the lines split by calendar month.
- Clio CSV column names are matched by common names; Clio lets users rename and hide report columns, so an unusual layout may need mapping by hand once.
- One OFX file per trust account: multi-account downloads are flagged, not split.

Independent project, not affiliated with Clio. Not legal or accounting advice.
