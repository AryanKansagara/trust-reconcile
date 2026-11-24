import { type Page } from '@playwright/test'
import { expect, fixture, test } from './support.ts'

async function blankAccount(page: Page) {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  await page.waitForURL(/\/data$/)
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible()
  return page.locator('input[type=file]')
}

/** Everything the app stored for this origin: projects and raw data, as text. */
const storedText = (page: Page) => page.evaluate(() => new Promise<string>((resolve, reject) => {
  const open = indexedDB.open('trust-reconcile')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const db = open.result
    const out: string[] = []
    const read = (name: string) => new Promise<void>(done => {
      const all = db.transaction(name).objectStore(name).getAll()
      all.onsuccess = () => { out.push(JSON.stringify(all.result)); done() }
    })
    void Promise.all([read('projects'), read('data')]).then(() => resolve(out.join('\n') + '\n' + JSON.stringify({ ...localStorage })))
  }
}))

const ACCOUNT_NUMBERS = ['000912340042', '000912340077', '123456789', '5551230042', '5551230177', '9990009999']

test.describe('OFX downloads with several accounts', () => {
  test('nothing is imported until the trust account is chosen, then only that account is imported', async ({ page }) => {
    const input = await blankAccount(page)
    await input.setInputFiles({ name: 'two-accounts.ofx', mimeType: 'application/octet-stream', buffer: fixture('two-accounts-sgml.ofx') })
    const card = page.locator('.pending', { hasText: 'two-accounts.ofx' })
    await expect(card.getByText('This file holds 2 accounts. Which one is the trust account?')).toBeVisible()

    // Each account is listed by type and the last four characters only, with its own totals.
    const trust = card.getByRole('radio', { name: /Checking account ending 0042/ })
    const operating = card.getByRole('radio', { name: /Checking account ending 0077/ })
    await expect(trust).not.toBeChecked()
    await expect(operating).not.toBeChecked()
    await expect(card.locator('.acct-opt', { hasText: '0042' })).toContainText('4 transactions, 2026-10-02 to 2026-10-29, closing balance $9,900.00')
    await expect(card.locator('.acct-opt', { hasText: '0077' })).toContainText('4 transactions, 2026-10-03 to 2026-10-22, closing balance $41,250.77')

    // No report, and the import button waits for a choice.
    await expect(card.locator('.report')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Choose the trust account first' })).toBeDisabled()
    await expect(page.locator('.cov.missing b').first()).toHaveText('Required')

    await trust.check()
    await expect(card.locator('.report')).toContainText('4 rows ready, 2026-10-02 to 2026-10-29, net $3,590.00')
    await expect(card.locator('.report')).toContainText('no problems')
    await expect(card.getByText('line 1')).toHaveCount(0)
    await card.getByRole('button', { name: 'Import 4 rows' }).click()
    await expect(page.getByText('Imported 4 rows of trust bank statement')).toBeVisible()

    await expect(page.locator('.cov.ok b')).toHaveText('4 lines')
    const row = page.locator('tbody tr', { hasText: 'two-accounts.ofx' })
    await expect(row).toContainText('OFX statement · Checking account ending 0042')
    await expect(row).not.toContainText('0077')

    // The statement balance is the chosen account's, and nothing of the other account was kept or shown.
    await page.getByRole('link', { name: /^Tie-out/ }).click()
    await expect(page.getByText('Statement closing balance')).toBeVisible()
    await expect(page.locator('.bridge', { hasText: 'Statement closing balance' })).toContainText('$9,900.00')
    const body = await page.locator('body').innerText()
    expect(body).not.toContain('41,250.77')
    expect(body).not.toMatch(/OFFICE LEASE|PAYROLL|CLIENT PAYMENT/)
    for (const n of ACCOUNT_NUMBERS) expect(body).not.toContain(n)

    await page.reload()
    await expect(page.locator('.bridge', { hasText: 'Statement closing balance' })).toContainText('$9,900.00')
    const stored = await storedText(page)
    expect(stored).toContain('CHECK 1043')
    expect(stored).not.toMatch(/OFFICE LEASE|PAYROLL|CLIENT PAYMENT|TRANSFER FROM TRUST/)
    for (const n of ACCOUNT_NUMBERS) expect(stored).not.toContain(n)
  })

  test('discarding the file without choosing saves nothing', async ({ page }) => {
    const input = await blankAccount(page)
    await input.setInputFiles({ name: 'two-accounts.ofx', mimeType: 'application/octet-stream', buffer: fixture('two-accounts-sgml.ofx') })
    const card = page.locator('.pending', { hasText: 'two-accounts.ofx' })
    await expect(card.getByRole('radio')).toHaveCount(2)
    await card.getByRole('button', { name: 'Discard' }).click()
    await expect(card).toHaveCount(0)
    await page.reload()
    await expect(page.locator('.cov.ok')).toHaveCount(0)
    const stored = await storedText(page)
    expect(stored).not.toMatch(/OFFICE LEASE|PAYROLL|CLIENT PAYMENT|CHECK 1043|DEPOSIT ID NUMBER/)
    for (const n of ACCOUNT_NUMBERS) expect(stored).not.toContain(n)
  })

  test('switching the choice shows the other account on its own', async ({ page }) => {
    const input = await blankAccount(page)
    await input.setInputFiles({ name: 'two-accounts.ofx', mimeType: 'application/octet-stream', buffer: fixture('two-accounts-sgml.ofx') })
    const card = page.locator('.pending', { hasText: 'two-accounts.ofx' })
    await card.getByRole('radio', { name: /ending 0042/ }).check()
    await expect(card.locator('.report')).toContainText('net $3,590.00')
    await card.getByRole('radio', { name: /ending 0077/ }).check()
    await expect(card.locator('.report')).toContainText('4 rows ready, 2026-10-03 to 2026-10-22, net $5,807.82')
    await expect(card.getByRole('button', { name: 'Import 4 rows' })).toBeEnabled()
  })

  test('OFX 2.x XML: an account with a balance and no transactions can be chosen and records its balance', async ({ page }) => {
    const input = await blankAccount(page)
    await input.setInputFiles({ name: 'two-accounts-xml.ofx', mimeType: 'application/x-ofx', buffer: fixture('two-accounts-xml.ofx') })
    const card = page.locator('.pending', { hasText: 'two-accounts-xml.ofx' })
    await expect(card.locator('.acct-opt', { hasText: '0177' })).toContainText('Savings account ending 0177')
    await expect(card.locator('.acct-opt', { hasText: '0177' })).toContainText('No transactions, closing balance $1,250.00')
    await expect(card.locator('.acct-opt', { hasText: '0042' })).toContainText('2 transactions, 2026-10-05 to 2026-10-14, closing balance $2,749.50')

    await card.getByRole('radio', { name: /Savings account ending 0177/ }).check()
    await expect(card.locator('.report')).toContainText('No transactions in this statement; its closing balance $1,250.00 as of 2026-10-31 will be recorded, no problems')
    await card.getByRole('button', { name: 'Import closing balance' }).click()
    await expect(page.getByText('Imported 0 rows of trust bank statement')).toBeVisible()
    await expect(page.locator('tbody tr', { hasText: 'two-accounts-xml.ofx' })).toContainText('Savings account ending 0177')
    const stored = await storedText(page)
    expect(stored).toContain('"2026-10"')
    expect(stored).toContain('125000')
    expect(stored).not.toContain('E-TRANSFER DEPOSIT')
  })

  test('OFX 2.x XML: the other account imports with its own lines and balance', async ({ page }) => {
    const input = await blankAccount(page)
    await input.setInputFiles({ name: 'two-accounts-xml.ofx', mimeType: 'application/x-ofx', buffer: fixture('two-accounts-xml.ofx') })
    const card = page.locator('.pending', { hasText: 'two-accounts-xml.ofx' })
    await card.getByRole('radio', { name: /Checking account ending 0042/ }).check()
    await expect(card.locator('.report')).toContainText('2 rows ready, 2026-10-05 to 2026-10-14, net $2,749.50, no problems')
    await card.getByRole('button', { name: 'Import 2 rows' }).click()
    await expect(page.getByText('Imported 2 rows of trust bank statement')).toBeVisible()
    await page.getByRole('link', { name: /^Tie-out/ }).click()
    await expect(page.locator('.bridge', { hasText: 'Statement closing balance' })).toContainText('$2,749.50')
  })

  test('a truncated statement reports line numbers and does not take in the next account', async ({ page }) => {
    const input = await blankAccount(page)
    const file = [
      'OFXHEADER:100',
      '<OFX><BANKMSGSRSV1>',
      '<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>5550001111<ACCTTYPE>CHECKING</BANKACCTFROM>',
      '<BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001<TRNAMT>100.00<FITID>1<NAME>FIRST</STMTTRN>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002',
      '<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>5550002222<ACCTTYPE>SAVINGS</BANKACCTFROM>',
      '<BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261003<TRNAMT>7.00<FITID>2<NAME>SECOND</STMTTRN>',
      '</BANKTRANLIST><LEDGERBAL><BALAMT>7.00<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS>',
      '</BANKMSGSRSV1></OFX>',
    ].join('\n')
    await input.setInputFiles({ name: 'cut-off.ofx', mimeType: 'application/octet-stream', buffer: Buffer.from(file) })
    const card = page.locator('.pending', { hasText: 'cut-off.ofx' })
    await expect(card.locator('.acct-opt', { hasText: '1111' })).toContainText('2 problems')
    await expect(card.locator('.acct-opt', { hasText: '2222' })).not.toContainText('problem')

    await card.getByRole('radio', { name: /ending 1111/ }).check()
    await expect(card.locator('.report')).toContainText('1 row ready, 2026-10-01 to 2026-10-01, net $100.00, 1 skipped, 2 problems')
    await expect(card.locator('.issues li', { hasText: 'line 6' })).toContainText('no valid TRNAMT')
    await expect(card.locator('.issues li', { hasText: 'line 3' })).toContainText('not closed')
    await expect(card.locator('.issues')).not.toContainText('SECOND')

    await card.getByRole('radio', { name: /Savings account ending 2222/ }).check()
    await expect(card.locator('.report')).toContainText('1 row ready, 2026-10-03 to 2026-10-03, net $7.00, no problems')
    await expect(card.locator('.issues')).toHaveCount(0)
  })

  test('a credit card in the file cannot be chosen as the trust account', async ({ page }) => {
    const input = await blankAccount(page)
    const bank = fixture('two-accounts-sgml.ofx').toString('latin1').match(/<BANKMSGSRSV1>[\s\S]*<\/BANKMSGSRSV1>/)![0]
    const card = '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>4111222233334411</CCACCTFROM><BANKTRANLIST>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-42.00<FITID>9<NAME>COFFEE</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-42.00<DTASOF>20261031</LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>'
    await input.setInputFiles({ name: 'with-card.ofx', mimeType: 'application/octet-stream', buffer: Buffer.from(`OFXHEADER:100\n<OFX>${bank}${card}</OFX>`) })
    const pending = page.locator('.pending', { hasText: 'with-card.ofx' })
    await expect(pending.getByText('This file holds 3 accounts.')).toBeVisible()
    const cc = pending.getByRole('radio', { name: /Credit card ending 4411/ })
    await expect(cc).toBeDisabled()
    await expect(pending.locator('.acct-opt', { hasText: '4411' })).toContainText('A credit card statement cannot be the trust account.')
    await expect(pending.getByRole('button', { name: 'Choose the trust account first' })).toBeDisabled()
    expect(await page.locator('body').innerText()).not.toContain('4111222233334411')
  })

  test('a download with a single account imports exactly as before, with no question asked', async ({ page }) => {
    const input = await blankAccount(page)
    await input.setInputFiles({ name: 'one-account.ofx', mimeType: 'application/octet-stream', buffer: fixture('ofxparse-bank_medium.ofx') })
    const card = page.locator('.pending', { hasText: 'one-account.ofx' })
    await expect(card.locator('.report')).toContainText('3 rows ready, 2009-04-01 to 2009-04-03')
    await expect(card.getByRole('radio')).toHaveCount(0)
    await card.getByRole('button', { name: 'Import 3 rows' }).click()
    await expect(page.getByText('Imported 3 rows of trust bank statement')).toBeVisible()
    // This fixture carries an Intuit id, so it is labelled QFX, as it always was.
    await expect(page.locator('tbody tr', { hasText: 'one-account.ofx' })).toContainText('QFX (Quicken / QuickBooks web connect)')
    await expect(page.locator('tbody tr', { hasText: 'one-account.ofx' })).not.toContainText('ending')
  })
})
