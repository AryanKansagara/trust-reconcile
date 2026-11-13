import { useEffect } from 'react'
import { KINDS, type Kind } from './engine/importer.ts'
import { DEFAULT_SETTINGS } from './engine/types.ts'
import { Code, Link } from './ui.tsx'

const SECTIONS = [
  ['start', 'Monthly routine'], ['clio', 'Clio Manage'], ['quickbooks', 'QuickBooks'], ['banks', 'Bank statements'], ['formats', 'File formats'],
  ['matching', 'How matching works'], ['findings', 'Findings'], ['rules', 'Reconciliation rules'], ['privacy', 'Privacy'], ['limits', 'Assumptions and limits'],
] as const

const GENERIC_BANK = `Date,Description,Amount,Check Number,Balance
2026-10-01,BRANCH DEPOSIT 2 ITEMS,7500.00,,84102.40
2026-10-03,CHECK 1188,-412.50,1188,83689.90
2026-10-31,MONTHLY SERVICE FEE,-15.00,,83674.90`

const GENERIC_JOURNAL = `Date,Matter,Client,Description,Reference,Funds In,Funds Out
2026-09-30,PI-2026-018,"Begay, Tyrone",Retainer cheque deposited,,5000.00,
2026-09-30,PI-2026-024,"Castillo, Ramon",Retainer cheque deposited,,2500.00,
2026-10-01,PI-2026-024,"Castillo, Ramon",Cheque to Desert Imaging LLC,1188,,412.50`

const GENERIC_BALANCES = `Matter,Client,Trust Balance,Last Activity
PI-2026-018,"Begay, Tyrone",5000.00,2026-09-30
PI-2026-024,"Castillo, Ramon",2087.50,2026-10-01`

export default function Docs() {
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView() }, [])
  return (
    <div className="docs">
      <nav className="docs-nav" aria-label="Docs sections">{SECTIONS.map(([id, l]) => <a key={id} href={`#${id}`}>{l}</a>)}</nav>
      <article>
        <div className="eyebrow">Docs · checked November 2026</div>
        <h1>Getting the three files out, and what the app does with them</h1>
        <p className="muted">A three-way reconciliation compares three independent records of the same money: what the bank says, what your trust journal says, and what the individual client ledgers add up to. You need one export of each.</p>

        <h2 id="start">The monthly routine</h2>
        <ol className="steps-list">
          <li>When the bank statement for the month arrives, download it as CSV, OFX or QFX (see <a href="#banks">banks</a>). Note the opening and closing balance printed on it.</li>
          <li>Export the trust journal from your practice or accounting system for the same month. Exporting from the account’s first transaction is better still: it lets the app see every earlier item that has not cleared.</li>
          <li>Export client trust balances as of the last day of the month. Optional, but it is what catches a client ledger that has drifted from the journal.</li>
          <li>Drop all three on the account’s <b>Data</b> tab. Check the validation report, fix or accept skipped lines, and import.</li>
          <li>Read the <b>Tie-out</b>. If it does not tie, work through <b>Exceptions</b> and record the suggested correcting entries in your system, then re-export and re-import.</li>
          <li>Close the month (<kbd>S</kbd>), open the report (<kbd>P</kbd>), sign as reconciler, and have the responsible lawyer sign as reviewer. Print or save the PDF with your trust records.</li>
        </ol>

        <h2 id="clio">Clio Manage</h2>
        <p>Report names below were checked against Clio’s help centre in November 2026 for US and Canadian accounts. Clio sometimes renames menu items and Australian accounts have a different set of trust reports, so if a label differs, look for the closest match.</p>
        <h3>Trust journal: the trust ledger report</h3>
        <ol className="steps-list">
          <li>Go to <span className="ui">Reports</span>, then the <span className="ui">Client reports</span> section, and choose <span className="ui">Trust ledger report</span>.</li>
          <li>Select all clients and the trust bank account. Set the date range to the statement month, or from the account’s opening date to month end.</li>
          <li>Tick <span className="ui">Include opening balance</span> if you only export one month; the opening balance rows are recognised and never matched against the bank.</li>
          <li>Choose <span className="ui">CSV</span> as the output format, generate, and download it from the report history.</li>
        </ol>
        <p>The CSV has <code>Date</code>, <code>Source/Destination</code>, <code>Payer/Payee</code>, <code>Matter</code>, <code>Description</code>, <code>Reference</code>, <code>Funds in</code>, <code>Funds out</code> and <code>Balance</code>. It is detected as “Clio Manage trust ledger report”. Client heading rows and subtotal rows are skipped and listed in the validation report.</p>
        <h3>Client balances: the trust listing report</h3>
        <ol className="steps-list">
          <li><span className="ui">Reports</span> → <span className="ui">Client reports</span> → <span className="ui">Trust listing report</span>.</li>
          <li>Select all clients, set the date to the last day of the statement month, choose <span className="ui">CSV</span>, and generate.</li>
          <li>When importing, set <b>Balances as of</b> to that same date if the file has no date column.</li>
        </ol>
        <h3>Clio’s own reconciliation</h3>
        <p>Clio Manage has a bank-to-ledger reconciliation under <span className="ui">Accounts</span> → the trust account → <span className="ui">Reconcile account</span> (administrators only), which exports a PDF report. Firms on Clio Accounting reconcile there instead. Use either alongside this app: Trust Reconcile adds the client-ledger leg, the explanations and the findings below, and keeps working when the numbers do not tie.</p>
        <div className="callout warn"><b>Transfer Funds vs Disburse Funds.</b> Earned fees should leave trust as a payment against the client’s bill (or a disbursement from that matter), which reduces that client’s ledger. Moving money between the firm’s bank accounts with a plain transfer moves real money but posts it to no client. Done for years, it produces a trust balance in the software far above the bank balance. The app flags every transfer to operating that has no matter or no invoice reference, plus any transfer on the bank statement that the journal never recorded.</div>

        <h2 id="quickbooks">QuickBooks</h2>
        <p>For firms that keep the trust journal in QuickBooks (a trust bank account plus a client trust liability account, with each client or matter as a customer or sub-customer):</p>
        <ol className="steps-list">
          <li>QuickBooks Online: <span className="ui">Reports</span> → <span className="ui">Transaction Detail by Account</span>. QuickBooks Desktop: <span className="ui">Reports</span> → <span className="ui">Custom Reports</span> → <span className="ui">Transaction Detail</span>.</li>
          <li>Filter to the trust bank account and the statement month.</li>
          <li>Customise columns to include <code>Date</code>, <code>Transaction Type</code>, <code>Num</code>, <code>Name</code>, <code>Customer</code> (or <code>Customer:Job</code>), <code>Memo/Description</code>, <code>Split</code> and <code>Amount</code>.</li>
          <li>Export to Excel and save the sheet as CSV.</li>
        </ol>
        <p><code>Customer:Job</code> values such as <code>Hale, Jordan:2026-014 Estate</code> are split into client and matter. For client balances, either export the trust liability account grouped by customer as of month end, or skip the third file and let the app derive balances from the journal.</p>

        <h2 id="banks">Bank statements</h2>
        <p>Download the month as CSV or as OFX/QFX (often labelled Quicken, Money or Web Connect). OFX/QFX files carry the closing ledger balance, so the statement balance is filled in for you. With CSV, a running balance column does the same; otherwise type the opening and closing balance from the statement on the Tie-out tab.</p>
        <table className="data">
          <thead><tr><th>Bank</th><th>Where</th><th>What we read</th></tr></thead>
          <tbody>
            <tr><th scope="row">Chase</th><td>Account activity → Download → CSV</td><td>Posting Date, Description, Amount, Check or Slip #, Balance</td></tr>
            <tr><th scope="row">Bank of America</th><td>Download transactions → Microsoft Excel format (CSV)</td><td>Date, Description, Amount, Running Bal.</td></tr>
            <tr><th scope="row">Wells Fargo</th><td>Download account activity → Comma delimited</td><td>No header row: date, amount, *, check number, description</td></tr>
            <tr><th scope="row">RBC Royal Bank</th><td>Download transactions → Comma delimited</td><td>Transaction Date, Cheque Number, Description 1 and 2, CAD$ / USD$</td></tr>
            <tr><th scope="row">TD Canada Trust</th><td>Download → Spreadsheet (CSV)</td><td>No header row: date, description, withdrawal, deposit, balance</td></tr>
            <tr><th scope="row">Anything else</th><td>CSV, TSV, OFX or QFX</td><td>A date plus either a signed amount or debit and credit columns</td></tr>
          </tbody>
        </table>
        <p className="muted small">Bank menus change often; the labels above are typical as of November 2026. Comma, tab, semicolon and pipe separators, quoted fields, parentheses negatives, trailing minus signs and DR/CR suffixes are all handled. Day-first dates (31/10/2026) are detected; tick the box during import if a file is ambiguous.</p>

        <h2 id="formats">File formats</h2>
        <p>Columns are matched by name (case and spacing ignored). Anything that does not match can be mapped by hand during import. Every rejected line is listed with its line number and can be downloaded as a CSV.</p>
        {(Object.keys(KINDS) as Kind[]).map(k => (
          <div key={k}>
            <h3>{KINDS[k].title}</h3>
            <table className="data">
              <thead><tr><th>Field</th><th>Recognised column names</th></tr></thead>
              <tbody>{KINDS[k].fields.map(f => <tr key={f.key}><th scope="row">{f.label}{f.required && <b className="req">*</b>}</th><td className="mono small">{f.aliases.join(', ')}</td></tr>)}</tbody>
            </table>
          </div>
        ))}
        <Code label="Minimal bank CSV" code={GENERIC_BANK} />
        <Code label="Minimal journal CSV" code={GENERIC_JOURNAL} />
        <Code label="Minimal client balances CSV" code={GENERIC_BALANCES} />

        <h2 id="matching">How matching works</h2>
        <ol className="steps-list">
          <li><b>Your manual matches</b> are applied first; auto-matches you reject are never made again.</li>
          <li><b>Cheques</b> match on cheque number and amount, clearing up to {DEFAULT_SETTINGS.chequeWindow} days after they were written.</li>
          <li><b>Everything else</b> matches on exact amount, taking the closest dates first, within {DEFAULT_SETTINGS.dateWindow} days (adjustable).</li>
          <li><b>Batched deposits</b>: one bank deposit that equals the sum of 2 to {DEFAULT_SETTINGS.batchMax} journal receipts on the same side, close in date, is matched as one-to-many.</li>
          <li><b>Carry-forward</b>: journal items that did not clear stay outstanding and are matched against later statements. Unmatched bank lines stay matchable for three months, so an entry recorded late still finds its bank line.</li>
        </ol>
        <p>The tie-out is: <b>adjusted bank</b> (statement closing + deposits in transit − outstanding cheques) = <b>trust journal</b> = <b>sum of client ledgers</b>. Bank minus journal is explained by statement lines that are not in the journal. Journal minus client ledgers is explained by journal entries posted to no client, and by client ledger balances that disagree with the journal. Anything left is shown as unexplained.</p>

        <h2 id="findings">Findings</h2>
        <table className="data">
          <tbody>
            <tr><th scope="row">Transfer to operating</th><td>Journal transfers to the firm with no matter (critical) or no invoice reference, and bank transfers to operating that are not in the journal. Suggests a reversal plus a disbursement against the matter.</td></tr>
            <tr><th scope="row">Negative client balance</th><td>Any matter whose running balance went below zero during the month, even briefly. Suggests replenishing from firm funds.</td></tr>
            <tr><th scope="row">Paid before deposit cleared</th><td>A payment made while the deposit funding it had not yet reached the bank, counting deposits from their bank date.</td></tr>
            <tr><th scope="row">Dormant balance</th><td>Non-zero balances with no activity for {DEFAULT_SETTINGS.staleMonths}+ months. Draft letters are on the Letters tab.</td></tr>
            <tr><th scope="row">Bank fee or interest in trust</th><td>Charges or interest on the statement that are not in the journal, or posted to a client ledger.</td></tr>
            <tr><th scope="row">Duplicates</th><td>Journal entries with the same matter, amount and reference (or the same date and description), and identical bank lines.</td></tr>
            <tr><th scope="row">Also</th><td>Stale-dated cheques ({DEFAULT_SETTINGS.staleChequeDays}+ days), deposits in transit over 10 days, statements whose lines do not add up to the closing balance, and client reports that disagree with the journal.</td></tr>
          </tbody>
        </table>

        <h2 id="rules">Reconciliation rules: a dated summary</h2>
        <div className="callout">Summary as of November 2026, for orientation only. Rules change and differ in detail; read your jurisdiction’s current text and your regulator’s trust accounting handbook.</div>
        <table className="data rules-table">
          <thead><tr><th>Rule</th><th>What it asks for</th></tr></thead>
          <tbody>
            <tr><th scope="row">ABA Model Rule 1.15 (Safekeeping Property)</th><td>Client funds kept in a separate trust account, complete records kept and preserved (the model suggests five years after the representation ends). The companion ABA Model Rules for Client Trust Account Records call for monthly trial balances and periodic reconciliations of the bank statement, the journal and the client ledgers, leaving the intervals for each state to set (the model text brackets monthly and quarterly).</td></tr>
            <tr><th scope="row">Arizona: ER 1.15 and Supreme Court Rule 43</th><td>Monthly three-way reconciliation of the trust account general ledger, the individual client ledgers and the bank statement.</td></tr>
            <tr><th scope="row">California: Rule 1.15 and the Board’s trust account standards</th><td>Monthly reconciliation (balancing) of the client ledgers, the account journal and the bank statements, with records kept for five years.</td></tr>
            <tr><th scope="row">Florida: Rule 5-1.2</th><td>Monthly reconciliation of the bank balance (with deposits in transit and outstanding checks) and a monthly comparison with the total of the client ledgers.</td></tr>
            <tr><th scope="row">Ontario: Law Society By-Law 9</th><td>A monthly comparison of the trust bank balance, the trust journal and the total of client trust ledger balances, with reasons for any difference, completed within 25 days after the end of the bank statement period.</td></tr>
            <tr><th scope="row">British Columbia: Law Society Rule 3-73</th><td>Monthly trust reconciliation of the bank, the trust records and the client listing, prepared within 30 days of its effective date (Rule 3-73(5)) and signed by the lawyer.</td></tr>
            <tr><th scope="row">Elsewhere</th><td>Many US states now require monthly three-way reconciliation; some (for example Illinois and Colorado) set quarterly as the minimum and recommend monthly. Monthly is the safe default.</td></tr>
          </tbody>
        </table>
        <p className="muted small">The compliance calendar treats a month as due 25 days after month end for Ontario, 30 days after month end for British Columbia (Rule 3-73(5); <a href="https://www.lawsociety.bc.ca/docs/trust/checklist_trust-accounting.pdf">LSBC trust accounting checklist</a>, checked November 2026) and at the end of the following month everywhere else. Change the rules an account reports against on its Data tab.</p>

        <h2 id="privacy">Privacy: what stays local</h2>
        <p>Files are read with the browser’s file API, parsed and reconciled in this tab, and stored in the browser’s IndexedDB. There is no upload step and no server-side processing. This matters to firms whose regulator cares about where client information is held, including Canadian firms asking about data residency.</p>
        <ul>
          <li>Signed out, nothing leaves the device.</li>
          <li>Signed in, with <b>Sync only totals, never client names</b> on (the default), the cloud holds account names, settings, monthly totals, counts of findings by type and sign-off names and dates. No client names, matter numbers, payees, descriptions or files.</li>
          <li>If you turn that setting off, client detail and imported files up to 1.5 MB per account also sync, so another device can open them.</li>
          <li>The account menu exports everything as JSON, deletes your cloud data, or deletes the account.</li>
        </ul>
        <p>Change it in <Link href="/settings">Settings</Link>.</p>

        <h2 id="limits">Assumptions and limits</h2>
        <ul>
          <li>One project is one trust bank account. Firms with several trust accounts create one each.</li>
          <li>For the first statement month imported, journal entries dated earlier that match nothing on that statement are assumed to have cleared before it. Import the previous statement to check them.</li>
          <li>If no statement balance is available, the opening balance is assumed to agree with the reconciled journal, and the report says so. Enter the real balances to confirm.</li>
          <li>Matching is exact to the cent. A bank line that differs by a few cents from the journal shows up as two items, which is usually what you want to see.</li>
          <li>The suggested correcting entries are proposals for a bookkeeper or lawyer to review, with <code>ASSIGN-MATTER</code> and <code>INV-____</code> placeholders where the app cannot know the answer. This is a working tool, not legal or accounting advice.</li>
        </ul>
      </article>
    </div>
  )
}
