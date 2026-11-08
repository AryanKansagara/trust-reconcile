import type { Config } from './engine/types.ts'
import { JURISDICTIONS } from './projectData.ts'
import { deleteProject, getProjects, saveProject, setPrefs, usePrefs, type Prefs } from './store.ts'
import { exportAll, syncNow, useSync } from './sync.ts'
import { ask, download, Link, setTheme, toast, useDark } from './ui.tsx'

export default function Settings() {
  const p = usePrefs()
  const dark = useDark()
  const sync = useSync()
  const save = (patch: Partial<Prefs>, msg = 'Saved') => { setPrefs(patch); toast(msg, { tone: 'ok', ttl: 1500 }) }

  const setTotalsOnly = async (on: boolean) => {
    if (!on && !(await ask('Sync client detail?', 'When you are signed in, client names, matter numbers, payees and imported files (up to 1.5 MB per account) will be stored in your cloud account so other devices can open them. Check that your rules and your clients allow this, including where the data is stored.', 'Allow full sync', false))) return
    save({ totalsOnly: on }, on ? 'Only totals will sync' : 'Full sync allowed')
    // Re-push every account so the cloud copy matches the new setting (totals-only overwrites any detail synced before).
    if (sync.user) { for (const x of getProjects()) await saveProject(x, { silent: true }); void syncNow() }
  }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel" id="privacy">
        <div className="panel-head"><h2>Privacy</h2>{sync.user ? <span className="chip neutral">Signed in as {sync.user.email}</span> : <span className="chip good">Signed out: nothing syncs</span>}</div>
        <label className="toggle">
          <input type="checkbox" checked={p.totalsOnly} onChange={e => void setTotalsOnly(e.target.checked)} />
          <span><b>Sync only totals, never client names</b><br /><span className="muted small">On by default. When you sign in to sync, only balances, counts, statement totals and sign-offs leave this device. Client names, matter numbers, payees, descriptions and the imported files stay here.</span></span>
        </label>
        <hr />
        <div className="local-list">
          <div>
            <h3>Always stays on this device</h3>
            <ul>
              <li>The bank statements, journals and balance files you import</li>
              <li>Client names, matter numbers, payees and descriptions{p.totalsOnly ? '' : ' (unless full sync is allowed above)'}</li>
              <li>Letters and their wording</li>
              <li>Everything, if you never sign in</li>
            </ul>
          </div>
          <div>
            <h3>Syncs when you sign in</h3>
            <ul>
              <li>Account names, rules and matching settings</li>
              <li>Monthly totals: adjusted bank, journal, client ledgers, outstanding amounts</li>
              <li>Counts of findings by type, and who signed each month</li>
              {!p.totalsOnly && <li>Client detail and imported files up to 1.5 MB per account</li>}
            </ul>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>Parsing and reconciliation run in your browser; there is no server step. <Link href="/docs#privacy">More on data handling</Link>.</p>
      </div>

      <div className="panel">
        <h2>Defaults for new trust accounts</h2>
        <p className="muted small">Each account keeps its own settings on its Data tab.</p>
        <div className="form-grid">
          <label className="field"><span>Rules</span>
            <select value={p.jurisdiction} onChange={e => save({ jurisdiction: e.target.value as Config['jurisdiction'] })}>{Object.entries(JURISDICTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          </label>
          <label className="field"><span>Currency</span>
            <select value={p.currency} onChange={e => save({ currency: e.target.value as Config['currency'] })}><option value="USD">US dollar</option><option value="CAD">Canadian dollar</option></select>
          </label>
          <label className="field"><span>Matching window (days)</span><input type="number" min="0" max="30" defaultValue={p.settings.dateWindow} onBlur={e => save({ settings: { ...p.settings, dateWindow: Math.min(30, Math.max(0, Number(e.target.value) || 0)) } })} /><small>How far apart a deposit’s journal date and bank date may be.</small></label>
          <label className="field"><span>Dormant balance after (months)</span><input type="number" min="1" max="60" defaultValue={p.settings.staleMonths} onBlur={e => save({ settings: { ...p.settings, staleMonths: Math.min(60, Math.max(1, Number(e.target.value) || 12)) } })} /><small>Non-zero balances with no activity for this long get a letter.</small></label>
          <label className="field"><span>Stale cheque after (days)</span><input type="number" min="30" max="400" defaultValue={p.settings.staleChequeDays} onBlur={e => save({ settings: { ...p.settings, staleChequeDays: Math.min(400, Math.max(30, Number(e.target.value) || 180)) } })} /></label>
          <label className="field"><span>Largest batched deposit (items)</span><input type="number" min="2" max="10" defaultValue={p.settings.batchMax} onBlur={e => save({ settings: { ...p.settings, batchMax: Math.min(10, Math.max(2, Number(e.target.value) || 6)) } })} /></label>
        </div>
      </div>

      <div className="panel">
        <h2>Firm and sign-off defaults</h2>
        <div className="form-grid">
          <label className="field"><span>Firm name</span><input defaultValue={p.firm.name} onBlur={e => save({ firm: { ...p.firm, name: e.target.value } })} /></label>
          <label className="field"><span>Address</span><input defaultValue={p.firm.address} onBlur={e => save({ firm: { ...p.firm, address: e.target.value } })} /></label>
          <label className="field"><span>Reconciler</span><input defaultValue={p.firm.reconciler} placeholder="Bookkeeper or paralegal" onBlur={e => save({ firm: { ...p.firm, reconciler: e.target.value } })} /></label>
          <label className="field"><span>Reviewer</span><input defaultValue={p.firm.reviewer} placeholder="Responsible lawyer" onBlur={e => save({ firm: { ...p.firm, reviewer: e.target.value } })} /></label>
        </div>
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg-control" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
          <button type="button" role="radio" aria-checked={dark} className={dark ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Trust accounts live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>.</> : 'Sign in from the account menu to use them on another device. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`trust-reconcile-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete every trust account?', `Removes ${list.length} account${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(x => deleteProject(x.id)))
            toast(`Deleted ${list.length} accounts`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all accounts</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>6</kbd></dt><dd>Switch tabs in an account</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next statement month</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Close the month</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable report and sign-off</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last change</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts in an account</dd></div>
        </dl>
      </div>
    </section>
  )
}
