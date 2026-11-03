import type { LngLat } from '../types'

// Free, key-less weather from Open-Meteo.
//  - Trip within the 16-day forecast window → the actual forecast.
//  - Further out → what those same dates looked like last year (archive),
//    clearly labelled as "typical", which is the honest best guess.

export interface DayWeather {
  date: string        // yyyy-mm-dd (trip date, even for "typical" data)
  code: number        // WMO weather code
  hi: number          // °C
  lo: number
  rain: number        // forecast: max chance of rain (%); typical: rain that day (mm)
}

export interface TripWeather {
  mode: 'forecast' | 'typical'
  days: DayWeather[]
}

const DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)
const cache = new Map<string, Promise<TripWeather>>()

export function getWeather([lng, lat]: LngLat, start: string, days: number): Promise<TripWeather> {
  const key = `${lat},${lng},${start},${days}`
  const hit = cache.get(key)
  if (hit) return hit
  const job = load(lat, lng, start, days)
  cache.set(key, job)
  job.catch(() => cache.delete(key))
  return job
}

async function load(lat: number, lng: number, start: string, days: number): Promise<TripWeather> {
  const first = new Date(`${start}T00:00:00Z`)
  const last = new Date(first.getTime() + (days - 1) * DAY)
  const today = new Date(iso(new Date()) + 'T00:00:00Z')
  const inWindow = first.getTime() >= today.getTime() - DAY && last.getTime() <= today.getTime() + 15 * DAY

  if (inWindow) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${iso(first)}&end_date=${iso(last)}`
    const d = (await (await fetch(url)).json()).daily
    return { mode: 'forecast', days: d.time.map((t: string, i: number) => ({ date: t, code: d.weather_code[i], hi: d.temperature_2m_max[i], lo: d.temperature_2m_min[i], rain: d.precipitation_probability_max[i] ?? 0 })) }
  }

  // Same calendar dates a year (or two) back, so the archive has caught up.
  let back = 1
  while (new Date(last).setUTCFullYear(last.getUTCFullYear() - back) > today.getTime() - 6 * DAY) back++
  const shift = (d: Date) => { const x = new Date(d); x.setUTCFullYear(d.getUTCFullYear() - back); return x }
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&start_date=${iso(shift(first))}&end_date=${iso(shift(last))}`
  const d = (await (await fetch(url)).json()).daily
  return {
    mode: 'typical',
    days: d.time.map((_: string, i: number) => ({ date: iso(new Date(first.getTime() + i * DAY)), code: d.weather_code[i], hi: d.temperature_2m_max[i], lo: d.temperature_2m_min[i], rain: d.precipitation_sum[i] ?? 0 })),
  }
}

// WMO code → a friendly label and icon.
export function describe(code: number): { label: string; icon: string } {
  if (code === 0) return { label: 'Clear', icon: '☀️' }
  if (code <= 2) return { label: 'Partly cloudy', icon: '⛅' }
  if (code === 3) return { label: 'Overcast', icon: '☁️' }
  if (code <= 48) return { label: 'Fog', icon: '🌫️' }
  if (code <= 57) return { label: 'Drizzle', icon: '🌦️' }
  if (code <= 67) return { label: 'Rain', icon: '🌧️' }
  if (code <= 77) return { label: 'Snow', icon: '🌨️' }
  if (code <= 82) return { label: 'Showers', icon: '🌦️' }
  if (code <= 86) return { label: 'Snow showers', icon: '🌨️' }
  return { label: 'Thunderstorms', icon: '⛈️' }
}

export const isWet = (d: DayWeather, mode: TripWeather['mode']) => (mode === 'forecast' ? d.rain >= 40 : d.rain >= 2) || (d.code >= 51 && d.code <= 99)
