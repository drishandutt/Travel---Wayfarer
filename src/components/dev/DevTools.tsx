import { useCallback, useEffect, useRef, useState } from 'react'
import { api, NetworkError } from '../../money/client'
import type { ShareRead } from '../../share/types'
import { useEscape } from '../money/parts'
import { siteName } from '../share/ShareSheet'

// The owner's dev tools (server/dev): every log line and error, the signed-in sessions the
// link reader uses, a way to try the reader, and tokens for the cookie-sync extension.
// New tools are new tabs.

interface LogRow { id: number; at: number; level: string; source: string; message: string; detail: string | null; user: string | null; url: string | null; agent: string | null }
interface Site { domain: string; count: number; names: string[]; signedIn: boolean; expires: number | null; source: string; updatedAt: number }
interface Token { id: string; label: string; createdAt: number; lastUsedAt: number | null }
interface Status { browser: string | null; ai: string | null; admins: string; uptime: number; memory: number }

type Tab = 'logs' | 'sessions' | 'reader' | 'extension'
const TABS: { id: Tab; label: string }[] = [
  { id: 'logs', label: 'Logs' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'reader', label: 'Link reader' },
  { id: 'extension', label: 'Extension' },
]

const errorText = (err: unknown) => (err instanceof NetworkError ? 'Can’t reach the server.' : (err as Error).message)
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000)
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}

export function DevTools({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('logs')
  const [status, setStatus] = useState<Status | null>(null)
  const [denied, setDenied] = useState('')
  useEscape(onClose)
  useEffect(() => { api<Status>('GET', '/dev/status').then(setStatus).catch(err => setDenied(errorText(err))) }, [])

  return (
    <div className="dash m-app dev-app" role="dialog" aria-label="Dev tools">
      <div className="m-group-bar">
        <button className="dash-back m-close" onClick={onClose}>← Map</button>
        <h1>Dev tools</h1>
        {status && (
          <span className="dev-status">
            <i className={status.browser ? 'ok' : 'bad'} />{status.browser ? 'Browser ready' : 'No browser: links read without one'}
            <i className={status.ai ? 'ok' : 'bad'} />{status.ai ? `AI: ${status.ai === 'claude' ? 'Claude' : 'OpenAI'}` : 'No AI key'}
            <span className="dev-faint">{status.memory} MB · up {Math.round(status.uptime / 60)} min</span>
          </span>
        )}
      </div>
      {denied ? (
        <div className="m-center"><p className="m-note bad">{denied}</p></div>
      ) : (
        <>
          <nav className="m-tabs" aria-label="Dev tools">
            {TABS.map(t => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
          </nav>
          <div className="dev-page">
            {tab === 'logs' && <Logs />}
            {tab === 'sessions' && <Sessions />}
            {tab === 'reader' && <Reader />}
            {tab === 'extension' && <Extension />}
          </div>
        </>
      )}
    </div>
  )
}

// ── logs ──────────────────────────────────────────────────────────────────────

function Logs() {
  const [rows, setRows] = useState<LogRow[]>([])
  const [more, setMore] = useState(false)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [levels, setLevels] = useState<string[]>([])
  const [source, setSource] = useState('')
  const [q, setQ] = useState('')
  const [live, setLive] = useState(true)
  const [open, setOpen] = useState<number | null>(null)
  const [error, setError] = useState('')
  const filters = useRef({ levels, source, q })
  filters.current = { levels, source, q }

  const load = useCallback(async (before?: number) => {
    const f = filters.current
    const params = new URLSearchParams({ limit: '200', ...(f.levels.length ? { level: f.levels.join(',') } : {}), ...(f.source ? { source: f.source } : {}), ...(f.q ? { q: f.q } : {}), ...(before ? { before: String(before) } : {}) })
    try {
      const out = await api<{ logs: LogRow[]; more: boolean; last24h: Record<string, number> }>('GET', `/dev/logs?${params}`)
      setRows(r => (before ? [...r, ...out.logs] : out.logs))
      setMore(out.more)
      setCounts(out.last24h)
      setError('')
    } catch (err) { setError(errorText(err)) }
  }, [])
  useEffect(() => { void load() }, [levels, source, load])
  useEffect(() => { const t = setTimeout(() => void load(), 300); return () => clearTimeout(t) }, [q, load])
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 5000)
    return () => clearInterval(t)
  }, [live, load])

  const toggleLevel = (l: string) => setLevels(ls => (ls.includes(l) ? ls.filter(x => x !== l) : [...ls, l]))
  const clear = async () => {
    if (!confirm('Delete every stored log line? This can’t be undone.')) return
    await api('DELETE', '/dev/logs').catch(err => setError(errorText(err)))
    void load()
  }

  return (
    <div className="dev-logs">
      <div className="dev-toolbar">
        {(['error', 'warn', 'info', 'debug'] as const).map(l => (
          <button key={l} className={`dev-chip lv-${l} ${levels.includes(l) ? 'on' : ''}`} aria-pressed={levels.includes(l)} onClick={() => toggleLevel(l)}>
            {l}<small>{counts[l] ?? 0}</small>
          </button>
        ))}
        <select value={source} onChange={e => setSource(e.target.value)} aria-label="Source">
          <option value="">Server and app</option>
          <option value="server">Server</option>
          <option value="client">App (browsers, iPhone)</option>
        </select>
        <input type="search" placeholder="Search messages, stacks, pages" value={q} onChange={e => setQ(e.target.value)} />
        <label className="dev-live"><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Live</label>
        <span className="m-spacer" />
        <button className="m-link danger-link" onClick={clear}>Clear all</button>
      </div>
      <p className="dev-faint">Counts are for the last 24 hours. Lines are kept for 30 days.</p>
      {error && <p className="m-note bad">{error}</p>}
      <ol className="dev-rows">
        {rows.map(r => (
          <li key={r.id} className={`lv-${r.level} ${open === r.id ? 'open' : ''}`}>
            <button onClick={() => setOpen(o => (o === r.id ? null : r.id))}>
              <time>{when(r.at)}</time>
              <span className={`dev-lv lv-${r.level}`}>{r.level}</span>
              <span className="dev-src">{r.source === 'client' ? 'app' : 'server'}</span>
              <span className="dev-msg">{r.message}</span>
            </button>
            {open === r.id && (
              <div className="dev-detail">
                <dl>
                  {r.user && <><dt>User</dt><dd>{r.user}</dd></>}
                  {r.url && <><dt>Page</dt><dd>{r.url}</dd></>}
                  {r.agent && <><dt>Device</dt><dd>{r.agent}</dd></>}
                </dl>
                <pre>{r.message}{r.detail ? `\n\n${r.detail}` : ''}</pre>
                <button className="ghost m-small" onClick={() => navigator.clipboard?.writeText(`${when(r.at)} [${r.level}] ${r.source}\n${r.message}\n${r.detail ?? ''}\n${r.url ?? ''}`)}>Copy</button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {!rows.length && !error && <p className="dev-faint">Nothing logged{levels.length || source || q ? ' that matches' : ' yet'}.</p>}
      {more && <button className="ghost" onClick={() => void load(rows.at(-1)?.id)}>Older</button>}
    </div>
  )
}

// ── sessions ──────────────────────────────────────────────────────────────────

const KNOWN_SITES = ['instagram.com', 'x.com', 'linkedin.com', 'tiktok.com', 'facebook.com', 'threads.net', 'youtube.com']

function Sessions() {
  const [sites, setSites] = useState<Site[] | null>(null)
  const [site, setSite] = useState('instagram.com')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const load = useCallback(() => api<{ sites: Site[] }>('GET', '/dev/cookies').then(r => setSites(r.sites)).catch(err => setNote({ text: errorText(err), bad: true })), [])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    setBusy(true)
    setNote(null)
    try {
      const out = await api<{ saved: { site: string; count: number }[] }>('PUT', '/dev/cookies', { site, cookies: paste })
      setNote({ text: `Saved ${out.saved.map(s => `${s.count} cookies for ${s.site}`).join(', ')}.` })
      setPaste('')
      void load()
    } catch (err) {
      setNote({ text: errorText(err), bad: true })
    } finally { setBusy(false) }
  }
  const remove = async (domain: string) => {
    if (!confirm(`Forget the ${domain} session? Links from there will be read signed out.`)) return
    await api('DELETE', `/dev/cookies/${encodeURIComponent(domain)}`).catch(err => setNote({ text: errorText(err), bad: true }))
    void load()
  }

  return (
    <div className="dev-sessions">
      <p className="dev-lede">Instagram, X, LinkedIn and others show posts only to someone signed in. The link reader opens shared links with the session saved here for that site. The easiest way to keep these fresh is the <b>Extension</b> tab. Use an account you don’t mind a server using.</p>
      {sites === null ? <div className="m-skeleton" /> : (
        <table className="dev-table">
          <thead><tr><th>Site</th><th>Signed in</th><th>Cookies</th><th>Login expires</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {sites.length === 0 && <tr><td colSpan={6} className="dev-faint">No sessions yet.</td></tr>}
            {sites.map(s => (
              <tr key={s.domain}>
                <td><b>{siteName(s.domain)}</b> <small className="dev-faint">{s.domain}</small></td>
                <td>{s.signedIn ? <span className="dev-ok">Yes</span> : <span className="dev-bad" title="The cookie that shows a login is missing or expired">No</span>}</td>
                <td title={s.names.join(', ')}>{s.count}</td>
                <td>{s.expires ? new Date(s.expires).toLocaleDateString() : '–'}</td>
                <td>{ago(s.updatedAt)} <small className="dev-faint">by {s.source}</small></td>
                <td><button className="m-link danger-link" onClick={() => remove(s.domain)}>Forget</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="card dev-form" onSubmit={e => { e.preventDefault(); void save() }}>
        <h3>Set a session by hand</h3>
        <label>
          <span>Site</span>
          <input list="dev-sites" value={site} onChange={e => setSite(e.target.value)} placeholder="instagram.com" />
          <datalist id="dev-sites">{KNOWN_SITES.map(s => <option key={s} value={s} />)}</datalist>
        </label>
        <label>
          <span>Cookies</span>
          <textarea rows={6} value={paste} onChange={e => setPaste(e.target.value)} spellCheck={false} autoComplete="off"
            placeholder={'Any of: the JSON from a cookie export, a cookies.txt file, or a Cookie header (sessionid=…; csrftoken=…)'} />
        </label>
        <div className="m-form-actions">
          {note && <span className={`m-note ${note.bad ? 'bad' : ''}`}>{note.text}</span>}
          <span className="m-spacer" />
          <button className="cta" disabled={busy || !paste.trim()}>{busy ? 'Saving…' : 'Save session'}</button>
        </div>
      </form>
    </div>
  )
}

// ── trying the reader ─────────────────────────────────────────────────────────

function Reader() {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<(ShareRead & { ms: number; debug?: { text: string; via: string; finalUrl: string } }) | null>(null)
  const [error, setError] = useState('')
  const run = async () => {
    setBusy(true)
    setError('')
    setOut(null)
    try { setOut(await api('POST', '/dev/read', { url })) } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  return (
    <div className="dev-reader">
      <form className="dev-toolbar" onSubmit={e => { e.preventDefault(); void run() }}>
        <input type="url" required placeholder="Paste a reel, video, post, search or page link" value={url} onChange={e => setUrl(e.target.value)} />
        <button className="cta m-small" disabled={busy || !url}>{busy ? 'Reading…' : 'Read it'}</button>
      </form>
      <p className="dev-faint">Reads it fresh, the way a shared link is read, and shows what the AI was given.</p>
      {error && <p className="m-note bad">{error}</p>}
      {out && (
        <div className="dev-read">
          <p><b>{out.title}</b> · {siteName(out.site)} {out.kind} · {out.ms} ms{out.debug ? ` · via ${out.debug.via}` : ''}{out.needsLogin ? ' · ' : ''}{out.needsLogin && <span className="dev-bad">hit a login wall</span>}</p>
          {out.debug && out.debug.finalUrl !== out.url && <p className="dev-faint">Ended up at {out.debug.finalUrl}</p>}
          {out.note && <p className="m-note">{out.note}</p>}
          <h4>Places ({out.places.length})</h4>
          <ol>{out.places.map((p, i) => <li key={i}><b>{p.name}</b> {[p.area, p.city, p.country].filter(Boolean).join(', ')} {p.cityId ? <span className="dev-ok">plannable: {p.cityId}</span> : <span className="dev-faint">no Wayfarer city</span>}<br /><small>{p.why}</small></li>)}</ol>
          {out.debug && <><h4>What the AI read</h4><pre>{out.debug.text}</pre></>}
        </div>
      )}
    </div>
  )
}

// ── the cookie-sync extension ─────────────────────────────────────────────────

function Extension() {
  const [tokens, setTokens] = useState<Token[] | null>(null)
  const [label, setLabel] = useState('Chrome on my Mac')
  const [fresh, setFresh] = useState<string | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => api<{ tokens: Token[] }>('GET', '/dev/tokens').then(r => setTokens(r.tokens)).catch(err => setError(errorText(err))), [])
  useEffect(() => { void load() }, [load])
  const make = async () => {
    try {
      const { token } = await api<{ token: string }>('POST', '/dev/tokens', { label })
      setFresh(token)
      void load()
    } catch (err) { setError(errorText(err)) }
  }
  const revoke = async (id: string) => {
    if (!confirm('Revoke this token? The extension using it stops syncing.')) return
    await api('DELETE', `/dev/tokens/${id}`).catch(err => setError(errorText(err)))
    void load()
  }
  return (
    <div className="dev-ext">
      <p className="dev-lede">The <b>Wayfarer cookie sync</b> Chrome extension (in the repo at <code>tools/cookie-sync</code>) sends your signed-in sessions for Instagram, X, LinkedIn, TikTok and the rest here whenever they change, so the link reader never falls behind a login.</p>
      <ol className="dev-steps">
        <li>In Chrome, open <code>chrome://extensions</code>, switch on <b>Developer mode</b>, choose <b>Load unpacked</b> and pick the <code>tools/cookie-sync</code> folder.</li>
        <li>Make a token below and paste it, with this site’s address ({location.origin}), into the extension’s settings.</li>
        <li>Sign in to the sites in that Chrome. The extension syncs straight away, then whenever their cookies change.</li>
      </ol>
      <form className="dev-toolbar" onSubmit={e => { e.preventDefault(); void make() }}>
        <input value={label} maxLength={60} onChange={e => setLabel(e.target.value)} aria-label="Token name" />
        <button className="cta m-small" disabled={!label.trim()}>Make a token</button>
      </form>
      {fresh && (
        <div className="m-banner dev-token">
          <span>Copy it now: it isn’t shown again.</span>
          <code>{fresh}</code>
          <button className="ghost m-small" onClick={() => navigator.clipboard?.writeText(fresh)}>Copy</button>
        </div>
      )}
      {error && <p className="m-note bad">{error}</p>}
      <table className="dev-table">
        <thead><tr><th>Token</th><th>Made</th><th>Last used</th><th /></tr></thead>
        <tbody>
          {tokens?.length === 0 && <tr><td colSpan={4} className="dev-faint">No tokens yet.</td></tr>}
          {tokens?.map(t => (
            <tr key={t.id}><td>{t.label}</td><td>{ago(t.createdAt)}</td><td>{t.lastUsedAt ? ago(t.lastUsedAt) : 'Never'}</td><td><button className="m-link danger-link" onClick={() => revoke(t.id)}>Revoke</button></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
