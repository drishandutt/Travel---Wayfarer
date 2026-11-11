import { useCallback, useEffect, useState } from 'react'
import { api } from '../../money/client'
import { errorText } from './util'

// What the models used: every call to Claude or OpenAI, by the job that made it and by model,
// with its tokens and web searches (server/usage.ts). Web searches cost the most, so the day's
// count is shown against its ceiling.

interface Row { job: string; calls: number; input: number; cached: number; output: number; reasoning: number; searches: number }
interface Spend { days: number; byJob: Row[]; byModel: (Row & { model: string })[]; total: Row; searchesToday: number; searchCap: number }

const JOB: Record<string, string> = {
  videos: 'Reels & TikToks', vibe: 'Local picks (mood search)', plan: 'Planning', intake: 'The conversation', hotels: 'Hotel pick', agent: 'Trip assistant',
  describe: 'Describing places', profiles: 'Profiling places', city: 'New cities', reader: 'Link reader', docs: 'Documents', analyst: 'Analyst', import: 'Pasted itineraries', other: 'Other',
}
const n = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v.toLocaleString())

export function Spend() {
  const [days, setDays] = useState(1)
  const [data, setData] = useState<Spend | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => {
    setErr(null)
    api<Spend>('GET', `/dev/usage?days=${days}`).then(setData).catch(e => setErr(errorText(e)))
  }, [days])
  useEffect(() => { void load() }, [load])

  const table = (rows: Row[], label: (r: Row) => string) => (
    <table className="dev-table dev-spend">
      <thead><tr><th>{data && rows === data.byJob ? 'Job' : 'Model'}</th><th>Calls</th><th>Tokens in</th><th>Tokens out</th><th>Web searches</th></tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={label(r)}>
            <td>{label(r)}</td>
            <td>{r.calls.toLocaleString()}</td>
            <td title={`${r.cached.toLocaleString()} of them cached`}>{n(r.input)}</td>
            <td title={`${r.reasoning.toLocaleString()} of them reasoning`}>{n(r.output)}</td>
            <td>{r.searches.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <div className="dev-spend-wrap">
      <div className="m-tabs" role="tablist" aria-label="Period">
        {[[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([d, l]) => (
          <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d as number)}>{l}</button>
        ))}
        <button className="ghost m-small" onClick={() => void load()}>Refresh</button>
      </div>
      {err && <p className="m-note bad">{err}</p>}
      {data && (
        <>
          <p className="dev-lede">
            <b>{data.total.calls.toLocaleString()}</b> model calls, <b>{n(data.total.input)}</b> tokens in, <b>{n(data.total.output)}</b> out, <b>{data.total.searches.toLocaleString()}</b> web searches.
            {' '}Today’s web searches: <b>{data.searchesToday}</b> of {data.searchCap} (WAYFARER_DAILY_WEB_SEARCHES). Counted since this was added; heaviest first.
          </p>
          {data.byJob.length ? table(data.byJob, r => JOB[r.job] ?? r.job) : <p className="dev-faint">Nothing yet in this period.</p>}
          {data.byModel.length > 0 && <><h3>By model</h3>{table(data.byModel, r => (r as Row & { model: string }).model || 'unknown')}</>}
        </>
      )}
    </div>
  )
}
