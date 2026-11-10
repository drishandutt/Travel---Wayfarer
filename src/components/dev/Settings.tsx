import { useCallback, useEffect, useState } from 'react'
import { api } from '../../money/client'
import { ago, errorText } from './util'

// Settings the owner changes without a redeploy. The OpenAI key is checked with OpenAI before
// it's kept, takes effect at once, and is never shown again: only where it came from and its
// last four characters.

interface Info { openai: { source: 'env' | 'dev tools' | null; tail: string | null; model: string; saved: { updatedAt: number; updatedBy: string | null } | null }; claude: boolean; analystEvery: string }

export function Settings({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const load = useCallback(() => api<Info>('GET', '/dev/settings').then(setInfo).catch(err => setNote({ text: errorText(err), bad: true })), [])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    setBusy(true)
    setNote(null)
    try {
      await api('PUT', '/dev/settings/openai', { key: key.trim() })
      setKey('')
      setNote({ text: 'Saved. OpenAI checked the key, and it’s in use now.' })
      void load()
      onChanged()
    } catch (err) { setNote({ text: errorText(err), bad: true }) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!confirm(info?.openai.source === 'dev tools' && info.openai.saved ? 'Remove the OpenAI key saved here? The server falls back to OPENAI_API_KEY if it has one.' : 'Remove the key?')) return
    try {
      await api('DELETE', '/dev/settings/openai')
      setNote({ text: 'Removed.' })
      void load()
      onChanged()
    } catch (err) { setNote({ text: errorText(err), bad: true }) }
  }

  const o = info?.openai
  return (
    <div className="dev-settings">
      <form className="card dev-form" onSubmit={e => { e.preventDefault(); void save() }} autoComplete="off">
        <h3>OpenAI</h3>
        <p className="dev-lede">
          {o?.source
            ? <>In use: a key ending <code>…{o.tail}</code>, {o.source === 'env' ? 'from the server’s OPENAI_API_KEY' : <>saved here{o.saved ? ` by ${o.saved.updatedBy ?? 'the owner'} ${ago(o.saved.updatedAt)}` : ''}</>}. Model <code>{o.model}</code>.</>
            : 'No OpenAI key yet.'}
          {' '}{info?.claude ? 'Claude is connected too, and is used first; OpenAI covers anything Claude can’t reach.' : 'With no Anthropic key on this server, OpenAI does the AI work: describing and profiling places, a new city’s essentials, the trip assistant, reels and TikToks, and the analyst.'}
        </p>
        <label>
          <span>{o?.source ? 'Replace it with' : 'Key'}</span>
          <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-…" autoComplete="new-password" spellCheck={false} aria-label="OpenAI API key" />
        </label>
        <p className="dev-faint">Kept in the server’s database, readable only by the server, and never sent back to a browser. Use a key from a project you can revoke.</p>
        <div className="m-form-actions">
          {note && <span className={`m-note ${note.bad ? 'bad' : ''}`}>{note.text}</span>}
          <span className="m-spacer" />
          {o?.source === 'dev tools' && <button type="button" className="ghost m-small danger" onClick={() => void remove()}>Remove</button>}
          <button className="cta" disabled={busy || key.trim().length < 20}>{busy ? 'Checking with OpenAI…' : 'Check and save'}</button>
        </div>
      </form>
      <section className="card">
        <h3>The analyst</h3>
        <p className="dev-lede">{info?.analystEvery === 'off' ? 'Scheduled reviews are off (WAYFARER_ANALYST_HOURS=off).' : `Reviews the activity every ${info?.analystEvery ?? 6} hours when at least 20 things have happened, if an AI is connected. Set WAYFARER_ANALYST_HOURS to change how often, or to "off".`}</p>
      </section>
    </div>
  )
}
