import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { codeMail, gmailFrom, lastCode, mailConfigured, mailProvider, rawMessage, sendMail } from './mail'

// Which service sends the sign-in codes, and what a code email says.

const saved = { ...process.env }
afterEach(() => {
  for (const k of ['RESEND_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'NODE_ENV']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('sending sign-in codes', () => {
  it('uses Resend first, then Gmail when both its settings are there, else nothing', () => {
    delete process.env.RESEND_API_KEY
    delete process.env.GMAIL_USER
    delete process.env.GMAIL_APP_PASSWORD
    assert.equal(mailProvider(), null)
    assert.equal(mailConfigured(), false)
    process.env.GMAIL_USER = 'someone@gmail.com'
    assert.equal(mailProvider(), null, 'an address alone isn’t enough')
    process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop'
    assert.equal(mailProvider(), 'gmail')
    process.env.GMAIL_CLIENT_ID = 'id'
    process.env.GMAIL_CLIENT_SECRET = 'secret'
    assert.equal(mailProvider(), 'gmail', 'the API needs its refresh token too')
    process.env.GMAIL_REFRESH_TOKEN = 'refresh'
    assert.equal(mailProvider(), 'gmail-api', 'the API beats SMTP: it works where mail ports are blocked')
    process.env.RESEND_API_KEY = 're_test'
    assert.equal(mailProvider(), 'resend')
    assert.equal(gmailFrom(' someone@gmail.com '), 'Wayfarer <someone@gmail.com>')
  })

  it('in production with no provider, refuses rather than letting anyone in', async () => {
    delete process.env.RESEND_API_KEY
    delete process.env.GMAIL_USER
    process.env.NODE_ENV = 'production'
    await assert.rejects(sendMail(codeMail('a@example.com', '123456', 'signin')), /aren’t set up/)
    assert.equal(lastCode('a@example.com'), undefined, 'and nothing is kept to read back')
  })

  it('in development, prints and keeps the code', async () => {
    delete process.env.RESEND_API_KEY
    delete process.env.GMAIL_USER
    delete process.env.NODE_ENV
    await sendMail(codeMail('dev@example.com', '654321', 'signup'))
    assert.equal(lastCode('DEV@example.com'), '654321')
  })

  it('says what the code is for, and escapes nothing it shouldn’t', () => {
    const m = codeMail('a@example.com', '012345', 'change')
    assert.equal(m.subject, '012345 is your Wayfarer code')
    assert.match(m.text, /confirm this as your new Wayfarer email is 012345/)
    assert.match(m.html, />012345</)
  })

  it('builds a proper message for Gmail’s API', async () => {
    const raw = Buffer.from(await rawMessage(codeMail('a@example.com', '012345', 'signin'), 'Wayfarer <sender@gmail.com>'), 'base64url').toString('utf8')
    assert.match(raw, /^From: Wayfarer <sender@gmail\.com>$/m)
    assert.match(raw, /^To: a@example\.com$/m)
    assert.match(raw, /^Subject: 012345 is your Wayfarer code$/m)
    assert.match(raw, /multipart\/alternative/)
  })

  it('sends through Gmail’s API with a token from the refresh token, and keeps the token', async () => {
    process.env.GMAIL_USER = 'sender@gmail.com'
    process.env.GMAIL_CLIENT_ID = 'id'
    process.env.GMAIL_CLIENT_SECRET = 'secret'
    process.env.GMAIL_REFRESH_TOKEN = 'refresh-abcdef'
    delete process.env.RESEND_API_KEY
    const real = globalThis.fetch
    const calls: { url: string; body: string; auth?: string }[] = []
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, body: String(init?.body), auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
      if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200 })
      return new Response('{"id":"m1"}', { status: 200 })
    }) as typeof fetch
    try {
      await sendMail(codeMail('a@example.com', '111222', 'signin'))
      await sendMail(codeMail('b@example.com', '333444', 'signin'))
    } finally {
      globalThis.fetch = real
    }
    assert.equal(calls.filter(c => c.url.includes('oauth2')).length, 1, 'one token for both')
    assert.match(calls[0].body, /grant_type=refresh_token/)
    const sends = calls.filter(c => c.url.includes('gmail/v1/users/me/messages/send'))
    assert.equal(sends.length, 2)
    assert.equal(sends[0].auth, 'Bearer at-1')
    assert.match(Buffer.from(JSON.parse(sends[0].body).raw, 'base64url').toString('utf8'), /111222/)
  })

  it('says plainly when Google won’t give a token', async () => {
    process.env.GMAIL_USER = 'sender@gmail.com'
    process.env.GMAIL_CLIENT_ID = 'other-id'
    process.env.GMAIL_CLIENT_SECRET = 'secret'
    process.env.GMAIL_REFRESH_TOKEN = 'revoked-zzzzzz'
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 })) as typeof fetch
    try {
      await assert.rejects(sendMail(codeMail('a@example.com', '111222', 'signin')), /Gmail access was refused/)
    } finally {
      globalThis.fetch = real
    }
  })
})
