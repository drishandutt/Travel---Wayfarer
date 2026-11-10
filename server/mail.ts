// Sending email: sign-in codes. Resend's HTTP API (https://resend.com) when RESEND_API_KEY is
// set, from WAYFARER_MAIL_FROM ("Wayfarer <login@your-domain>", a domain verified with Resend).
// Without a key, in development the message is printed to the server console and kept in
// memory for the tests (`lastCode`); in production nothing is sent and sign-in says so, rather
// than letting anyone in unverified.

export class MailError extends Error {}

export interface Mail { to: string; subject: string; text: string; html: string }

type Sender = (m: Mail) => Promise<void>

const PRODUCTION = () => process.env.NODE_ENV === 'production'

const outbox = new Map<string, Mail & { at: number }>()

// The last message sent to an address, in development only. For the tests, and for signing in
// locally without an email provider.
export function lastMail(to: string): (Mail & { at: number }) | undefined {
  if (PRODUCTION()) return undefined
  return outbox.get(to.toLowerCase())
}
export const lastCode = (to: string) => lastMail(to)?.text.match(/\b(\d{6})\b/)?.[1]

let override: Sender | null = null
// Tests can catch what would be sent.
export function setSender(s: Sender | null) { override = s }

export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY) || override !== null

async function viaResend(m: Mail) {
  const from = process.env.WAYFARER_MAIL_FROM ?? 'Wayfarer <onboarding@resend.dev>'
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[mail] Resend refused a message (${res.status}): ${body.slice(0, 300)}`)
    throw new MailError('The sign-in email couldn’t be sent just now. Try again in a minute.')
  }
}

export async function sendMail(m: Mail): Promise<void> {
  if (override) return override(m)
  if (process.env.RESEND_API_KEY) return viaResend(m)
  if (PRODUCTION()) {
    console.error('[mail] RESEND_API_KEY is unset: sign-in codes can’t be sent, so nobody can sign in.')
    throw new MailError('Sign-in emails aren’t set up on this server yet, so signing in is paused. Try again later.')
  }
  outbox.set(m.to.toLowerCase(), { ...m, at: Date.now() })
  // development only: the code where the person running the server can see it
  process.stdout.write(`\n[mail] to ${m.to}: ${m.subject}\n${m.text}\n\n`)
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// The sign-in (or new-address) code email.
export function codeMail(to: string, code: string, purpose: 'signin' | 'signup' | 'change'): Mail {
  const what = purpose === 'signup' ? 'finish making your Wayfarer account' : purpose === 'change' ? 'confirm this as your new Wayfarer email' : 'sign in to Wayfarer'
  const subject = `${code} is your Wayfarer code`
  const text = `Your code to ${what} is ${code}.\n\nIt works once, for 10 minutes. If you didn’t ask for it, ignore this email: nobody can get in without the code.`
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1d1d1f">
<p style="font-size:15px;margin:0 0 16px">Your code to ${esc(what)}:</p>
<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:0 0 16px">${esc(code)}</p>
<p style="font-size:13px;color:#6e6e73;margin:0">It works once, for 10 minutes. If you didn’t ask for it, ignore this email: nobody can get in without the code.</p>
</div>`
  return { to, subject, text, html }
}
