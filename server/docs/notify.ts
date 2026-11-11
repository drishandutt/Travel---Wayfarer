import type { Db } from '../money/db'
import { type Mail, sendMail } from '../mail'
import { track } from '../dev/activity'
import { claimDue, markEmailed, resyncTripChecks } from './store'

// Delivering alerts: once a minute, every alert that's come due is marked delivered (so it
// shows in the app) and emailed to its person unless they've turned that off. The iPhone app
// schedules the same alerts on the phone itself ahead of time, so they arrive even offline.
// Every hour, passports, IDs, visas and insurance are checked against trips again, since trips
// get dates and new trips get made.

let site = process.env.WAYFARER_PUBLIC_URL?.replace(/\/+$/, '') ?? null
// the address people reach the app on, learned from requests when it isn't configured
export function seenAt(base: string) { if (!process.env.WAYFARER_PUBLIC_URL) site = base }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function alertMail(to: string, a: { title: string; body: string }, base: string | null): Mail {
  const link = base ? `${base}/?docs` : null
  const lines = a.body.split(' · ')
  const text = `${a.title}\n\n${lines.join('\n')}${link ? `\n\nYour documents: ${link}` : ''}\n\nYou get these because you keep travel documents in Wayfarer. Turn emails off in your Profile.`
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1d1d1f">
<p style="font-size:18px;font-weight:600;margin:0 0 12px">${esc(a.title)}</p>
${lines.map(l => `<p style="font-size:15px;margin:0 0 6px">${/^https:\/\//.test(l) ? `<a href="${esc(l)}" style="color:#0a66c2">${esc(l)}</a>` : esc(l)}</p>`).join('\n')}
${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#1d1d1f;color:#fff;text-decoration:none;font-size:14px">Open your documents</a></p>` : ''}
<p style="font-size:12px;color:#6e6e73;margin:20px 0 0">You get these because you keep travel documents in Wayfarer. Turn emails off in your Profile.</p>
</div>`
  return { to, subject: a.title, text, html }
}

export async function deliverDue(db: Db, now = Date.now()): Promise<number> {
  const due = await claimDue(db, now)
  for (const a of due) {
    track('alert.delivered', { userId: a.user_id, subject: a.id, detail: { kind: a.kind, late: Math.round((now - Number(a.due_at)) / 60_000) } })
    // an alert more than a day late (the server was down) goes to the app, not the inbox
    if (!a.alert_email || now - Number(a.due_at) > 86_400_000) continue
    try {
      await sendMail(alertMail(a.email, a, site))
      await markEmailed(db, a.id)
    } catch (err) {
      console.warn('[docs] emailing an alert', a.id, (err as Error).message)
    }
  }
  return due.length
}

let timers: NodeJS.Timeout[] = []
export function startAlertDelivery(db: Db) {
  if (timers.length) return
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try { await deliverDue(db) } catch (err) { console.warn('[docs] delivering alerts', (err as Error).message) } finally { busy = false }
  }
  timers = [
    setInterval(() => { void tick() }, 60_000),
    setInterval(() => { void resyncTripChecks(db).catch(err => console.warn('[docs] trip checks', (err as Error).message)) }, 3_600_000),
  ]
  for (const t of timers) t.unref()
  void tick()
}
export function stopAlertDelivery() { for (const t of timers) clearInterval(t); timers = [] }
