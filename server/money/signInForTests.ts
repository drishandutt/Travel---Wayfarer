import assert from 'node:assert/strict'
import { lastCode } from '../mail'

// Signing in the way the app does, for tests: the email (and a name for a new account), then
// the code that was "sent" (kept in memory in development, see ../mail.ts), then the password if
// the account has one. `call` is the test's own request function, which keeps its cookie.

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>

export async function signInVia(call: Call, email: string, name?: string, password?: string): Promise<{ id: string; name: string; email: string; hasPassword: boolean }> {
  let r = await call('POST', '/auth/email', { email })
  if (r.data.next === 'name') r = await call('POST', '/auth/email', { email, name: name ?? 'Someone' })
  assert.equal(r.data.next, 'code', `sign-in for ${email}: ${r.status} ${JSON.stringify(r.data)}`)
  const code = lastCode(email.trim().toLowerCase())
  assert.ok(code, `a code was sent to ${email}`)
  let v = await call('POST', '/auth/verify', { email, code, ...(password ? { password } : {}) })
  if (v.data.next === 'password') v = await call('POST', '/auth/verify', { email, code, password: password ?? '' })
  assert.ok(v.status === 200 && v.data.user, `verifying ${email}: ${v.status} ${JSON.stringify(v.data)}`)
  return v.data.user
}
