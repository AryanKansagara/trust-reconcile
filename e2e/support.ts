import { readFileSync } from 'node:fs'
import { expect, test as base } from '@playwright/test'

export const fixture = (name: string) => readFileSync(new URL(`../src/engine/fixtures/${name}`, import.meta.url))

export { expect }

/**
 * Every test runs signed out in a fresh browser context (so empty IndexedDB), with Supabase blocked.
 * A test fails if the page throws an uncaught error or anything tries to reach Supabase.
 */
export const test = base.extend<{ guard: { errors: string[]; supabase: string[] } }>({
  guard: [async ({ context, page }, use) => {
    const errors: string[] = []
    const supabase: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await context.route(/supabase\.(co|in)/, route => { supabase.push(route.request().url()); return route.abort() })
    const guard = { errors, supabase }
    await use(guard)
    expect(errors, 'uncaught page errors').toEqual([])
    expect(supabase, 'requests to Supabase while signed out').toEqual([])
  }, { auto: true }],
})

