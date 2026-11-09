import type { Db } from '../money/db'
import type { Cookie } from '../share/browser'

// Signed-in sessions for sites that hide posts behind a login. Set from the dev tools (pasted)
// or by the cookie-sync Chrome extension (tools/cookie-sync), one row per site, and handed
// to the link reader's browser for that site only.

// The session cookie that shows someone is signed in, per site.
export const LOGIN_COOKIES: Record<string, string[]> = {
  'instagram.com': ['sessionid'],
  'x.com': ['auth_token'],
  'twitter.com': ['auth_token'],
  'linkedin.com': ['li_at'],
  'tiktok.com': ['sessionid', 'sid_tt'],
  'facebook.com': ['c_user', 'xs'],
  'threads.net': ['sessionid'],
  'threads.com': ['sessionid'],
  'youtube.com': ['SID', '__Secure-3PSID'],
  'google.com': ['SID', '__Secure-3PSID'],
}

const TWO_PART = /^(?:co|com|org|net|ac|gov|edu)\.[a-z]{2}$/

// "www.instagram.com" and ".instagram.com" are both "instagram.com"
export function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '').split('.')
  const lastTwo = parts.slice(-2).join('.')
  return parts.length > 2 && TWO_PART.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo
}

// Chrome's cookie objects (chrome.cookies, EditThisCookie and similar exports), Playwright's own,
// a Cookie header ("a=1; b=2"), or a Netscape cookies.txt.
export function parseCookies(input: unknown, siteHint?: string): Cookie[] {
  const site = siteHint ? siteOf(siteHint) : undefined
  if (typeof input === 'string') {
    const text = input.trim()
    if (text.startsWith('[') || text.startsWith('{')) return parseCookies(JSON.parse(text), siteHint)
    if (/^#|\t/m.test(text) && text.split('\n').some(l => l.split('\t').length >= 7)) {
      return text.split('\n').filter(l => l && !l.startsWith('#') || l.startsWith('#HttpOnly_')).map(l => {
        const httpOnly = l.startsWith('#HttpOnly_')
        const [domain, , path, secure, expires, name, ...value] = l.replace(/^#HttpOnly_/, '').split('\t')
        return cookie({ domain, path, secure: secure === 'TRUE', expires: Number(expires) || -1, name, value: value.join('\t').trim(), httpOnly })
      }).filter(valid)
    }
    if (!site) throw new Error('Say which site these cookies are for')
    return text.replace(/^cookie:\s*/i, '').split(/;\s*/).filter(Boolean).map(pair => {
      const i = pair.indexOf('=')
      return cookie({ name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: `.${site}` })
    }).filter(valid)
  }
  const list = Array.isArray(input) ? input : (input as { cookies?: unknown[] })?.cookies
  if (!Array.isArray(list)) throw new Error('Expected a list of cookies')
  return list.map(raw => {
    const c = raw as Record<string, unknown>
    return cookie({
      name: String(c.name ?? ''),
      value: String(c.value ?? ''),
      domain: String(c.domain ?? (site ? `.${site}` : '')),
      path: typeof c.path === 'string' ? c.path : '/',
      expires: typeof c.expirationDate === 'number' ? c.expirationDate : typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: typeof c.sameSite === 'string' ? c.sameSite : undefined,
    })
  }).filter(valid)
}

function cookie(c: { name: string; value: string; domain: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string }): Cookie {
  const ss = (c.sameSite ?? '').toLowerCase()
  const sameSite: Cookie['sameSite'] = ss === 'strict' ? 'Strict' : ss === 'none' || ss === 'no_restriction' ? 'None' : 'Lax'
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    // a session cookie has no expiry; Playwright wants -1 for that
    expires: c.expires && c.expires > 0 ? Math.floor(c.expires) : -1,
    httpOnly: Boolean(c.httpOnly),
    // SameSite=None is only accepted on a secure cookie
    secure: Boolean(c.secure) || sameSite === 'None',
    sameSite,
  }
}

const valid = (c: Cookie) => Boolean(c.name && c.domain && !/[\r\n]/.test(c.value))

// Grouped by site: one paste can hold cookies for several.
export async function saveCookies(db: Db, cookies: Cookie[], source: string): Promise<{ site: string; count: number }[]> {
  const bySite = new Map<string, Cookie[]>()
  for (const c of cookies) {
    const site = siteOf(c.domain)
    bySite.set(site, [...(bySite.get(site) ?? []), c])
  }
  const out: { site: string; count: number }[] = []
  for (const [site, list] of bySite) {
    await db.run(`INSERT INTO dev_cookies (domain, cookies, source, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (domain) DO UPDATE SET cookies = excluded.cookies, source = excluded.source, updated_at = excluded.updated_at`,
      site, JSON.stringify(list), source.slice(0, 60), Date.now())
    out.push({ site, count: list.length })
  }
  return out
}

export async function cookiesFor(db: Db | null, host: string): Promise<Cookie[]> {
  if (!db) return []
  const site = siteOf(host)
  // x.com and twitter.com are the same account
  const sites = site === 'twitter.com' ? ['twitter.com', 'x.com'] : site === 'x.com' ? ['x.com', 'twitter.com'] : [site]
  const rows = await db.all<{ cookies: string }>(`SELECT cookies FROM dev_cookies WHERE domain IN (${sites.map(() => '?').join(', ')})`, ...sites)
  const now = Date.now() / 1000
  return rows.flatMap(r => JSON.parse(r.cookies) as Cookie[]).filter(c => c.expires === -1 || c.expires > now)
}

export interface CookieSite { domain: string; count: number; names: string[]; signedIn: boolean; expires: number | null; source: string; updatedAt: number }

export async function listCookieSites(db: Db): Promise<CookieSite[]> {
  const rows = await db.all<{ domain: string; cookies: string; source: string; updated_at: number }>('SELECT * FROM dev_cookies ORDER BY domain')
  const now = Date.now() / 1000
  return rows.map(r => {
    const list = (JSON.parse(r.cookies) as Cookie[]).filter(c => c.expires === -1 || c.expires > now)
    const login = LOGIN_COOKIES[r.domain] ?? []
    const loginCookies = list.filter(c => login.includes(c.name))
    const ends = loginCookies.map(c => c.expires).filter(e => e > 0)
    return {
      domain: r.domain,
      count: list.length,
      names: list.map(c => c.name).slice(0, 40),
      signedIn: login.length ? loginCookies.length > 0 : list.length > 0,
      expires: ends.length ? Math.min(...ends) * 1000 : null,
      source: r.source,
      updatedAt: r.updated_at,
    }
  })
}
