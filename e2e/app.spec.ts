import { type Page } from '@playwright/test'
import { expect, fixture, test } from './support.ts'

async function openSample(page: Page, id: 'reyes' | 'marlowe') {
  await page.goto(`/app?sample=${id}`)
  await page.waitForURL(/\/app\/p\/[\w-]+$/)
  await expect(page.locator('.status-hero')).toBeVisible()
}

const matchedCount = async (page: Page) => Number((await page.getByRole('heading', { name: /Matched this month/ }).innerText()).match(/\((\d+)\)/)![1])

test.describe('sample firm', () => {
  test('shows the three-way tie-out and the findings for the firm with the classic mistakes', async ({ page }) => {
    await openSample(page, 'reyes')
    await expect(page.getByRole('heading', { level: 1, name: 'Reyes Injury & Estates' })).toBeVisible()
    await expect(page.getByText('Synthetic', { exact: false }).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'October 2026 does not tie out' })).toBeVisible()
    for (const col of ['1 · Bank', '2 · Trust journal', '3 · Client ledgers']) await expect(page.getByRole('heading', { name: col })).toBeVisible()
    await expect(page.getByText('Adjusted bank balance')).toBeVisible()
    await expect(page.getByText('Bank − journal')).toBeVisible()
    await expect(page.getByText('Journal − client ledgers')).toBeVisible()

    await page.getByRole('button', { name: '3 critical findings' }).first().click()
    await expect(page).toHaveURL(/\/exceptions/)
    const cards = page.locator('article.ex')
    await expect(cards.first()).toBeVisible()
    await expect(page.locator('article.ex.critical')).toHaveCount(3)
    await expect(page.getByRole('heading', { level: 3 }).filter({ hasText: /no client|negative|overdrawn|transfer/i }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Correcting entries CSV' }).first()).toBeVisible()
  })

  test('the clean firm ties out to the cent', async ({ page }) => {
    await openSample(page, 'marlowe')
    await expect(page.getByRole('heading', { name: 'October 2026 ties out to the cent' })).toBeVisible()
    await expect(page.locator('.chip.good', { hasText: 'Ties out' })).toBeVisible()
  })
})

test.describe('matching', () => {
  test('rejecting a match and matching it again by hand updates the result', async ({ page }) => {
    await openSample(page, 'reyes')
    await page.getByRole('link', { name: /^Matching/ }).click()
    await expect(page.getByRole('heading', { name: /Matched this month/ })).toBeVisible()
    const before = await matchedCount(page)
    expect(before).toBe(15)
    await expect(page.getByRole('heading', { name: /Outstanding in the journal \(3,/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /On the statement, not in the journal \(2,/ })).toBeVisible()

    // Reject the incoming wire match: both sides drop back to the open lists.
    const row = page.locator('tr', { hasText: 'INCOMING WIRE W10853' })
    await row.getByRole('button', { name: 'Unmatch' }).click()
    await expect(page.getByText('Unmatched. The engine will not pair these again.')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Matched this month \(14\)/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Outstanding in the journal \(4,/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /On the statement, not in the journal \(3,/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /^Matching/ }).locator('.count')).toHaveText('7')

    // The rejection survives a reload.
    await page.reload()
    await expect(page.getByRole('heading', { name: /Matched this month \(14\)/ })).toBeVisible()

    // Match the same two items by hand; the button only enables when the amounts agree.
    await page.getByLabel('Select INCOMING WIRE W10853').check()
    const matchBtn = page.getByRole('button', { name: 'Match selected' })
    await expect(matchBtn).toBeDisabled()
    await page.getByLabel('Select Wire received').check()
    await expect(matchBtn).toBeEnabled()
    await matchBtn.click()
    await expect(page.getByText('Matched 1 bank line to 1 journal entry')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Matched this month \(15\)/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Outstanding in the journal \(3,/ })).toBeVisible()
    await expect(page.locator('tr', { hasText: 'INCOMING WIRE W10853' }).locator('.how')).toHaveText('manual')
  })
})

test.describe('report and sign-off', () => {
  test('opens the printable report with sign-off fields, and a signature survives a reload', async ({ page }) => {
    await openSample(page, 'reyes')
    await page.getByRole('link', { name: 'Report & sign-off' }).click()
    await expect(page).toHaveURL(/\/report/)
    const sheet = page.locator('article.sheet')
    await expect(sheet.getByRole('heading', { level: 1, name: 'Reyes Injury & Estates' })).toBeVisible()
    await expect(sheet.getByText('Monthly three-way trust reconciliation')).toBeVisible()
    await expect(sheet.getByText('SYNTHETIC SAMPLE')).toBeVisible()
    await expect(sheet.getByText(/Not reconciled\. A − B =/)).toBeVisible()
    await expect(sheet.getByText('Prepared by (reconciler)')).toBeVisible()
    await expect(sheet.getByText('Reviewed by (responsible lawyer)')).toBeVisible()
    await expect(sheet.locator('.sig-label').first()).toContainText('Date __________')
    await expect(page.getByRole('button', { name: 'Print or save PDF' })).toBeVisible()

    await page.getByLabel('Reconciler').fill('Pat Preparer')
    await page.getByRole('button', { name: 'Sign' }).click()
    await expect(page.getByText('Signed as reconciler')).toBeVisible()
    await expect(sheet.getByText('Prepared by (reconciler): Pat Preparer')).toBeVisible()
    await expect(sheet.locator('.sig-label').first()).not.toContainText('__________')

    await page.reload()
    await expect(page.getByLabel('Reconciler')).toHaveValue('Pat Preparer')
    await expect(sheet.getByText('Prepared by (reconciler): Pat Preparer')).toBeVisible()
  })
})

test.describe('importing files', () => {
  async function blankAccount(page: Page) {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    await page.waitForURL(/\/data$/)
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible()
    return page.locator('input[type=file]')
  }

  test('an unreadable or wrong-format file gets a useful message and the app stays usable', async ({ page }) => {
    const input = await blankAccount(page)

    await input.setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) })
    await expect(page.getByText('empty.csv is empty.')).toBeVisible()

    await input.setInputFiles({ name: 'letter.txt', mimeType: 'text/plain', buffer: Buffer.from('Dear client,\nPlease find the engagement letter attached.\nRegards') })
    const letter = page.locator('.pending', { hasText: 'letter.txt' })
    await expect(letter.getByText('The columns do not match a statement, journal or balance export we know.')).toBeVisible()

    await input.setInputFiles({ name: 'broken.ofx', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 3, 250, 251, 252, 0, 0, 9, 9]) })
    const broken = page.locator('.pending', { hasText: 'broken.ofx' })
    await expect(broken.getByText('No <STMTTRN> transactions found. Is this an OFX/QFX statement download?')).toBeVisible()
    await expect(broken.getByText('line 1')).toBeVisible()
    await expect(broken.getByRole('button', { name: /^Import 0 rows/ })).toBeDisabled()

    // A readable file with one bad row reports the line number and still imports the good rows.
    const chase = fixture('chase.csv').toString('utf8').trimEnd() + '\nDEBIT,not-a-date,"BROKEN ROW",-5.00,ACCT_XFER,1.00,,\n'
    await input.setInputFiles({ name: 'chase-bad-row.csv', mimeType: 'text/csv', buffer: Buffer.from(chase) })
    const bad = page.locator('.pending', { hasText: 'chase-bad-row.csv' })
    await expect(bad.getByText(/line \d+/)).toBeVisible()
    await expect(bad.getByText(/is not a date/)).toBeVisible()
    await expect(bad.getByRole('button', { name: /^Import \d+ rows/ })).toBeEnabled()

    // Still usable: discard the bad ones, navigate, open another page.
    await broken.getByRole('button', { name: 'Discard' }).click()
    await expect(broken).toHaveCount(0)
    await page.getByRole('link', { name: 'Docs' }).first().click()
    await expect(page).toHaveURL(/\/docs/)
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible()
  })

  test('imported data and settings survive a reload (local persistence)', async ({ page }) => {
    const input = await blankAccount(page)
    await input.setInputFiles({ name: 'chase.csv', mimeType: 'text/csv', buffer: fixture('chase.csv') })
    const card = page.locator('.pending', { hasText: 'chase.csv' })
    await expect(card.getByText(/no problems/)).toBeVisible()
    await card.getByRole('button', { name: /^Import \d+ rows/ }).click()
    await expect(page.getByText(/^Imported \d+ rows? of trust bank statement/i)).toBeVisible()
    const loaded = page.locator('.cov.ok b')
    await expect(loaded).toHaveText('4 lines')
    await expect(page.locator('tbody th', { hasText: 'chase.csv' })).toBeVisible()

    await page.getByLabel('Firm name (report and letters)').fill('Persisted Firm LLP')
    await page.getByLabel('Account name').fill('Persisted trust account')
    await page.getByLabel('Account name').blur()
    await page.getByLabel('Firm name (report and letters)').blur()
    await expect(page.getByRole('heading', { level: 1, name: 'Persisted trust account' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Persisted trust account' })).toBeVisible()
    await expect(page.getByLabel('Firm name (report and letters)')).toHaveValue('Persisted Firm LLP')
    await expect(page.locator('.cov.ok b')).toHaveText('4 lines')
    await expect(page.locator('tbody th', { hasText: 'chase.csv' })).toBeVisible()

    // And the workspace list still has the account.
    await page.goto('/app')
    await expect(page.getByRole('link', { name: 'Persisted trust account' })).toBeVisible()
  })
})

test('the whole app works signed out with Supabase blocked', async ({ page, guard }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Trust that ties')
  await page.getByRole('link', { name: 'Try the sample firm' }).click()
  await page.waitForURL(/\/app\/p\//)
  await expect(page.getByRole('heading', { name: /does not tie out/ })).toBeVisible()
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.goto('/docs')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(guard.supabase).toEqual([])
})
