// node scripts/qa-check.mjs <email> <password> : prints what a QA account stored in the cloud
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const [email, password] = process.argv.slice(2)
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => l.split('=')))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
const { error } = await sb.auth.signInWithPassword({ email, password })
if (error) { console.log('sign-in failed:', error.message); process.exit(1) }
const { data: p } = await sb.from('projects').select('id,app,name,data').eq('app', 'trust-reconcile')
const { data: v } = await sb.from('project_versions').select('id,label,data').in('project_id', (p ?? []).map(x => x.id))
const blob = JSON.stringify({ p, v })
console.log('projects', p?.length, 'versions', v?.length, 'bytes', blob.length, 'has dataset', p?.some(x => x.data.dataset))
for (const word of ['Gutierrez', 'Lindqvist', 'Whitcombe', 'Okafor', 'PI-2026-031', 'Banner Health']) console.log(word, blob.includes(word) ? 'LEAKED' : 'absent')
console.log('sample version', JSON.stringify(v?.[0]?.data).slice(0, 300))
