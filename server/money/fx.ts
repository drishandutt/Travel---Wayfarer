import type { Db } from './db'

// Exchange rates, cached per base currency per day. Two free, keyless sources: the first
// covers about 160 currencies, the fallback (ECB) about 30. If both are down, the last
// known rates are served and marked stale; the expense form lets people type a rate too.

export interface FxRates { base: string; date: string; rates: Record<string, number>; stale: boolean; source: string }

async function fromExchangeRateApi(base: string): Promise<Omit<FxRates, 'stale'>> {
  const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`er-api ${res.status}`)
  const data = await res.json() as { result: string; rates?: Record<string, number> }
  if (data.result !== 'success' || !data.rates) throw new Error('er-api: bad response')
  return { base, date: new Date().toISOString().slice(0, 10), rates: data.rates, source: 'ExchangeRate-API' }
}

async function fromFrankfurter(base: string): Promise<Omit<FxRates, 'stale'>> {
  const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}`, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`frankfurter ${res.status}`)
  const data = await res.json() as { date: string; rates: Record<string, number> }
  return { base, date: data.date, rates: { ...data.rates, [base]: 1 }, source: 'European Central Bank' }
}

const inFlight = new Map<string, Promise<FxRates | null>>()

export function getRates(db: Db, base: string, fetchers = [fromExchangeRateApi, fromFrankfurter]): Promise<FxRates | null> {
  const day = new Date().toISOString().slice(0, 10)
  const cached = db.one<{ rates: string }>('SELECT rates FROM fx_cache WHERE base = ? AND day = ?', base, day)
  if (cached) return Promise.resolve({ ...JSON.parse(cached.rates), stale: false })

  // many people opening the form at once only needs one upstream call
  const key = `${base}:${day}`
  const running = inFlight.get(key)
  if (running) return running
  const job = (async () => {
    for (const fetcher of fetchers) {
      try {
        const fresh = await fetcher(base)
        db.run('INSERT OR REPLACE INTO fx_cache (base, day, rates, fetched_at) VALUES (?, ?, ?, ?)', base, day, JSON.stringify(fresh), Date.now())
        return { ...fresh, stale: false }
      } catch (err) {
        console.warn('[fx]', (err as Error).message)
      }
    }
    const last = db.one<{ rates: string }>('SELECT rates FROM fx_cache WHERE base = ? ORDER BY day DESC LIMIT 1', base)
    return last ? { ...JSON.parse(last.rates), stale: true } as FxRates : null
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, job)
  return job
}
