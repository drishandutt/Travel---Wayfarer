// Gets the GMAIL_REFRESH_TOKEN that lets the server send sign-in codes through Gmail's API
// (server/mail.ts), once. Run it on your own computer:
//
//   npx tsx scripts/gmail-token.mts
//
// It asks for the OAuth client ID and secret (a "Desktop app" client from Google Cloud Console),
// opens Google's consent page, and prints the refresh token when you've allowed it. Sign in there
// as the address the codes should come from. Only the gmail.send permission is asked for: the
// token can send mail as you, and can't read or delete any.

import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const SCOPE = 'https://www.googleapis.com/auth/gmail.send'

async function ask(question: string, env?: string): Promise<string> {
  if (env && process.env[env]) return process.env[env]!.trim()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(question)).trim()
  rl.close()
  return answer
}

const clientId = await ask('OAuth client ID: ', 'GMAIL_CLIENT_ID')
const clientSecret = await ask('OAuth client secret: ', 'GMAIL_CLIENT_SECRET')
if (!clientId || !clientSecret) { console.error('Both are needed.'); process.exit(1) }

const state = randomBytes(16).toString('hex')
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')

const server = createServer()
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const redirect = `http://127.0.0.1:${port}`

const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
  access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
})}`

console.log(`\nOpening Google in your browser. If it doesn't open, go to:\n\n${url}\n`)
execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], () => {})

const code = await new Promise<string>((resolve, reject) => {
  server.on('request', (req, res) => {
    const q = new URL(req.url ?? '/', redirect).searchParams
    if (q.get('state') !== state) { res.end('This doesn’t match the request. Close this tab.'); return }
    const c = q.get('code')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(c ? '<p style="font:16px system-ui;padding:2em">Done. You can close this tab and go back to the terminal.</p>' : `<p style="font:16px system-ui;padding:2em">Google said: ${q.get('error') ?? 'no code'}. Close this tab.</p>`)
    if (c) resolve(c)
    else reject(new Error(q.get('error') ?? 'no code'))
  })
})
server.close()

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
})
const body = await res.json() as { refresh_token?: string; error?: string; error_description?: string }
if (!body.refresh_token) {
  console.error(`\nGoogle didn't give a refresh token: ${body.error ?? res.status} ${body.error_description ?? ''}`)
  process.exit(1)
}
console.log(`\nAdd this on Railway as GMAIL_REFRESH_TOKEN (and keep it private):\n\n${body.refresh_token}\n`)
process.exit(0)
