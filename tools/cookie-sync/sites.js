// The sites whose sessions are synced, and the cookie on each that means "signed in".
// Keep in step with LOGIN_COOKIES in server/dev/cookies.ts.
export const SITES = [
  { site: 'instagram.com', name: 'Instagram', login: ['sessionid'] },
  { site: 'x.com', name: 'X', login: ['auth_token'] },
  { site: 'linkedin.com', name: 'LinkedIn', login: ['li_at'] },
  { site: 'tiktok.com', name: 'TikTok', login: ['sessionid', 'sid_tt'] },
  { site: 'facebook.com', name: 'Facebook', login: ['c_user'] },
  { site: 'threads.net', name: 'Threads', login: ['sessionid'] },
  { site: 'youtube.com', name: 'YouTube', login: ['SID', '__Secure-3PSID'] },
]

export const DEFAULTS = { server: 'https://wayfarer-production-3acc.up.railway.app', token: '', enabled: SITES.map(s => s.site) }

export async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(['server', 'token', 'enabled'])) }
}
