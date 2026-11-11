import { AsyncLocalStorage } from 'node:async_hooks'
import { track } from './dev/activity'

// What the models cost: every call to Claude or OpenAI, with its tokens and web searches, by the
// job that made it (the reels search, the planner, the analyst…). The SDK clients send through
// `meteredFetch`, which reads the usage off each reply, so no call site can be missed; a job names
// itself with `asJob`, and anything unnamed counts as "other". Each call is logged as a
// `model.usage` activity (kept 90 days), which the dev tools' Spend tab adds up.
//
// Web searches cost the most, so there's a daily ceiling on them across everyone
// (WAYFARER_DAILY_WEB_SEARCHES, 300 unless set): past it, the jobs that search do without.

export type Job = 'intake' | 'plan' | 'hotels' | 'vibe' | 'agent' | 'import' | 'videos' | 'describe' | 'profiles' | 'city' | 'reader' | 'docs' | 'analyst' | 'other'

const jobs = new AsyncLocalStorage<Job>()
export const asJob = <T>(job: Job, fn: () => Promise<T>): Promise<T> => jobs.run(job, fn)
export function asJobGen<T, R>(job: Job, gen: () => AsyncGenerator<T, R>): AsyncGenerator<T, R> {
  // a generator runs in pieces; each piece runs inside the job
  const it = jobs.run(job, gen)
  return {
    next: (...a: [] | [unknown]) => jobs.run(job, () => it.next(...a)),
    return: (v: R) => jobs.run(job, () => it.return(v)),
    throw: (e: unknown) => jobs.run(job, () => it.throw(e)),
    [Symbol.asyncIterator]() { return this },
  } as AsyncGenerator<T, R>
}
export const currentJob = (): Job => jobs.getStore() ?? 'other'

export interface Usage { provider: 'openai' | 'claude'; model: string; job: Job; input: number; cached: number; output: number; reasoning: number; searches: number }

// today's web searches on this server (a restart starts the count again: a ceiling, not a bill)
let day = ''
let searchesToday = 0
const today = () => new Date().toISOString().slice(0, 10)
function rollDay() { const d = today(); if (d !== day) { day = d; searchesToday = 0 } }
export const SEARCH_CAP = () => Number(process.env.WAYFARER_DAILY_WEB_SEARCHES) || 300
export function canSearch(n = 1): boolean { rollDay(); return searchesToday + n <= SEARCH_CAP() }
export function searchesUsedToday(): number { rollDay(); return searchesToday }

// The usage in a reply from either provider, or undefined when it carries none.
export function usageOf(provider: 'openai' | 'claude', body: unknown, job: Job): Usage | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, any>
  const u = b.usage as Record<string, any> | undefined
  if (!u) return undefined
  if (provider === 'openai') {
    const searches = Array.isArray(b.output) ? b.output.filter((o: { type?: string }) => o?.type === 'web_search_call').length : 0
    return { provider, model: String(b.model ?? ''), job, input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? 0, searches }
  }
  return { provider, model: String(b.model ?? ''), job, input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: 0, searches: u.server_tool_use?.web_search_requests ?? 0 }
}

export function record(u: Usage) {
  rollDay()
  searchesToday += u.searches
  track('model.usage', { subject: u.job, detail: { ...u } })
}

// fetch for the SDK clients: answers pass through untouched, and the usage on each is recorded
export function meteredFetch(provider: 'openai' | 'claude'): typeof fetch {
  return async (input, init) => {
    const job = currentJob()
    const res = await fetch(input, init)
    if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
      res.clone().json().then(body => { const u = usageOf(provider, body, job); if (u) record(u) }).catch(() => {})
    }
    return res
  }
}

// Adding up `model.usage` activity: by job, then by model.
export interface SpendRow { job: string; calls: number; input: number; cached: number; output: number; reasoning: number; searches: number }
export function addUp(rows: Usage[]): { byJob: SpendRow[]; byModel: (SpendRow & { model: string })[]; total: SpendRow } {
  const empty = (job: string): SpendRow => ({ job, calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, searches: 0 })
  const add = (a: SpendRow, u: Usage) => { a.calls++; a.input += u.input; a.cached += u.cached; a.output += u.output; a.reasoning += u.reasoning; a.searches += u.searches }
  const jobsMap = new Map<string, SpendRow>()
  const models = new Map<string, SpendRow & { model: string }>()
  const total = empty('all')
  for (const u of rows) {
    if (!jobsMap.has(u.job)) jobsMap.set(u.job, empty(u.job))
    add(jobsMap.get(u.job)!, u)
    if (!models.has(u.model)) models.set(u.model, { ...empty('all'), model: u.model })
    add(models.get(u.model)!, u)
    add(total, u)
  }
  const heavy = (a: SpendRow, b: SpendRow) => (b.input + b.output * 4 + b.searches * 4000) - (a.input + a.output * 4 + a.searches * 4000)
  return { byJob: [...jobsMap.values()].sort(heavy), byModel: [...models.values()].sort(heavy), total }
}
