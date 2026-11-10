import nodemailer, { type Transporter } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'

// Sending email: sign-in codes. In order of preference:
//   Resend     RESEND_API_KEY, from WAYFARER_MAIL_FROM ("Wayfarer <login@your-domain>", a domain
//              verified with Resend)
//   Gmail API  GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN: sends
//              through Gmail's web API over HTTPS, which works where outgoing mail ports are
//              blocked (Railway's free and Hobby plans). `scripts/gmail-token.mts` gets the token.
//   Gmail SMTP GMAIL_USER and GMAIL_APP_PASSWORD (an app password from the Google account, which
//              needs 2-Step Verification on): needs outgoing mail ports, so Railway Pro or elsewhere.
// Gmail sends up to about 500 messages a day from a personal account, from that address.
// With neither, in development the message is printed to the server console and kept in memory
// for the tests (`lastCode`); in production nothing is sent and sign-in says so, rather than
// letting anyone in unverified.

export class MailError extends Error {}

export type Provider = 'resend' | 'gmail-api' | 'gmail' | null

export function mailProvider(): Provider {
  if (process.env.RESEND_API_KEY) return 'resend'
  if (process.env.GMAIL_USER && process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) return 'gmail-api'
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return 'gmail'
  return null
}

// ── Gmail's web API ──────────────────────────────────────────────────────────

let access: { token: string; until: number; key: string } | null = null

// A short-lived access token from the long-lived refresh token, kept until just before it expires.
async function gmailAccessToken(): Promise<string> {
  const key = `${process.env.GMAIL_CLIENT_ID}:${(process.env.GMAIL_REFRESH_TOKEN ?? '').slice(-6)}`
  if (access && access.key === key && access.until > Date.now() + 60_000) return access.token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID!.trim(), client_secret: process.env.GMAIL_CLIENT_SECRET!.trim(), refresh_token: process.env.GMAIL_REFRESH_TOKEN!.trim(), grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !body.access_token) {
    // invalid_grant: the refresh token was revoked, or expired because the Google app is still in "Testing"
    console.error(`[mail] Google wouldn’t give an access token (${body.error ?? res.status}): ${body.error_description ?? ''}`)
    throw new MailError('Sign-in emails can’t be sent right now (the server’s Gmail access was refused).')
  }
  access = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000, key }
  return access.token
}

// The whole message, as Gmail's API wants it: RFC 822, base64url.
export async function rawMessage(m: Mail, from: string): Promise<string> {
  const built = await new MailComposer({ from, to: m.to, subject: m.subject, text: m.text, html: m.html }).compile().build()
  return built.toString('base64url')
}

async function viaGmailApi(m: Mail) {
  const token = await gmailAccessToken()
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: await rawMessage(m, gmailFrom()) }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 401) access = null
    console.error(`[mail] Gmail’s API refused a message (${res.status}): ${body.slice(0, 300)}`)
    throw new MailError('The sign-in email couldn’t be sent just now. Try again in a minute.')
  }
}

// Gmail's own address is the sender: it rewrites any other From. The name can be ours.
export const gmailFrom = (user = process.env.GMAIL_USER ?? '') => `Wayfarer <${user.trim()}>`

let gmail: { key: string; transport: Transporter } | null = null
function gmailTransport(): Transporter {
  const user = process.env.GMAIL_USER!.trim()
  // app passwords are shown in groups of four; the spaces aren't part of it
  const pass = process.env.GMAIL_APP_PASSWORD!.replace(/\s+/g, '')
  const key = `${user}:${pass.length}:${pass.slice(-2)}`
  if (gmail?.key !== key) {
    gmail = { key, transport: nodemailer.createTransport({ service: 'gmail', auth: { user, pass }, pool: true, maxConnections: 2, connectionTimeout: 10_000, socketTimeout: 15_000 }) }
  }
  return gmail.transport
}

async function viaGmail(m: Mail) {
  try {
    await gmailTransport().sendMail({ from: gmailFrom(), to: m.to, subject: m.subject, text: m.text, html: m.html })
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; message?: string }
    console.error(`[mail] Gmail refused a message (${e.responseCode ?? e.code ?? 'error'}): ${(e.message ?? '').slice(0, 300)}`)
    // 535: the address or app password is wrong; 550/554 with daily limit text: Gmail's sending cap
    throw new MailError(e.responseCode === 535 ? 'Sign-in emails can’t be sent right now (the server’s email login was refused).' : 'The sign-in email couldn’t be sent just now. Try again in a minute.')
  }
}

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

export const mailConfigured = () => mailProvider() !== null || override !== null

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
  const provider = mailProvider()
  if (provider === 'resend') return viaResend(m)
  if (provider === 'gmail-api') return viaGmailApi(m)
  if (provider === 'gmail') return viaGmail(m)
  if (PRODUCTION()) {
    console.error('[mail] No email provider (RESEND_API_KEY; or GMAIL_USER with GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN; or GMAIL_USER with GMAIL_APP_PASSWORD): sign-in codes can’t be sent, so nobody can sign in.')
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
