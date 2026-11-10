import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { codeMail, gmailFrom, lastCode, mailConfigured, mailProvider, sendMail } from './mail'

// Which service sends the sign-in codes, and what a code email says.

const saved = { ...process.env }
afterEach(() => {
  for (const k of ['RESEND_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'NODE_ENV']) {
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
})
