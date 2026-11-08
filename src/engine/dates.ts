export const dayNum = (d: string) => Math.round(Date.parse(d + 'T00:00:00Z') / 86400000)
export const fromDayNum = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10)
export const monthOf = (d: string) => d.slice(0, 7)
export const monthEnd = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}` }
export const monthStart = (m: string) => `${m}-01`
export const addMonths = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7) }
export const monthsBetween = (a: string, b: string) => { const [ya, ma] = a.split('-').map(Number); const [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + (mb - ma) }

/** Parses the date formats banks and practice-management exports use. Returns YYYY-MM-DD or null. */
export function parseDate(raw: string, dayFirst = false): string | null {
  const s = raw.trim().replace(/^"|"$/g, '')
  if (!s) return null
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\d{6})?(?:\.\d+)?(?:\[.*\])?$/) // OFX 20261031120000[-5:EST]
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/)
  if (m) {
    let a = +m[1], b = +m[2]
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    if (a > 12 || (dayFirst && b <= 12)) [a, b] = [b, a]
    return ymd(y, a, b)
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-,]+(\d{4})/) // 31-Oct-2026, 31 Oct 2026
  if (m && months.includes(m[2].toLowerCase())) return ymd(+m[3], months.indexOf(m[2].toLowerCase()) + 1, +m[1])
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/) // Oct 31, 2026
  if (m && months.includes(m[1].toLowerCase())) return ymd(+m[3], months.indexOf(m[1].toLowerCase()) + 1, +m[2])
  return null
}

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null
  return dt.toISOString().slice(0, 10)
}

/** "$1,234.50", "(1,234.50)", "-1234.5", "1.234,50" (European) → cents, or NaN. */
export function parseMoney(raw: string): number {
  let s = raw.trim().replace(/^"|"$/g, '')
  if (!s || /^(null|n\/a|-|—)$/i.test(s)) return NaN
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (/CR$/i.test(s)) s = s.replace(/CR$/i, '')
  else if (/DR$/i.test(s)) { neg = !neg; s = s.replace(/DR$/i, '') }
  s = s.replace(/[$€£\s]|CAD|USD/gi, '')
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1) }
  else if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1) }
  if (s.startsWith('+')) s = s.slice(1)
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  if (!/^\d*\.?\d+$/.test(s)) return NaN
  const c = Math.round(Number(s) * 100)
  return neg ? -c : c
}
