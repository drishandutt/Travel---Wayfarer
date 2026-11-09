import { SITES, settings } from './sites.js'

// Sends a site's cookies to Wayfarer when they change (signing in, a refreshed session),
// on start-up, every half hour, and when asked from the popup. Only sites you're signed in
// to are sent; the rest are left alone.

const DEBOUNCE_MS = 20_000
const timers = new Map()

const siteFor = domain => SITES.find(s => domain.replace(/^\./, '') === s.site || domain.endsWith(`.${s.site}`))

async function record(site, status) {
  const { status: all = {} } = await chrome.storage.local.get('status')
  all[site] = { ...status, at: Date.now() }
  await chrome.storage.local.set({ status: all })
}

export async function syncSite(entry) {
  const { server, token, enabled } = await settings()
  if (!enabled.includes(entry.site)) return
  if (!token) return record(entry.site, { ok: false, error: 'Add a token in the settings' })
  const cookies = await chrome.cookies.getAll({ domain: entry.site })
  if (!cookies.some(c => entry.login.includes(c.name))) return record(entry.site, { ok: false, error: 'Not signed in in this Chrome' })
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/api/money/dev/cookies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ site: entry.site, cookies }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return record(entry.site, { ok: false, error: body.error || `Server answered ${res.status}` })
    return record(entry.site, { ok: true, count: cookies.length })
  } catch (err) {
    return record(entry.site, { ok: false, error: `Can’t reach ${server}: ${err.message}` })
  }
}

export async function syncAll() {
  for (const s of SITES) await syncSite(s)
}

chrome.cookies.onChanged.addListener(({ cookie }) => {
  const entry = siteFor(cookie.domain)
  if (!entry) return
  clearTimeout(timers.get(entry.site))
  timers.set(entry.site, setTimeout(() => { timers.delete(entry.site); syncSite(entry) }, DEBOUNCE_MS))
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sync', { periodInMinutes: 30 })
  syncAll()
})
chrome.runtime.onStartup.addListener(() => syncAll())
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'sync') syncAll() })
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === 'sync-now') { syncAll().then(() => reply(true)); return true }
})
