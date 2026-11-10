import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Db } from '../money/db'
import { OAuthError, authorizationServer, authorizeDecision, authorizePage, protectedResource, registerClient, revokeEndpoint, tokenEndpoint } from './oauth'
import { handleMcp } from './index'

// The HTTP side of Wayfarer's MCP server: OAuth discovery, sign-in and tokens (./oauth.ts), and
// the MCP endpoint itself (./index.ts). Mounted by server/index.ts for these paths:
//   /.well-known/oauth-*, /api/oauth/*, /api/mcp

// The discovery documents, token and registration endpoints are called by apps from anywhere,
// and carry no cookies: they're open to any origin. The authorize page isn't.
const OPEN = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate' }

async function bodyText(req: IncomingMessage, limit: number): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) { size += c.length; if (size > limit) throw new OAuthError('invalid_request', 'Request too large', 413); chunks.push(c) }
  return Buffer.concat(chunks).toString('utf8')
}

async function formOf(req: IncomingMessage): Promise<URLSearchParams> {
  const text = await bodyText(req, 64 * 1024)
  if (String(req.headers['content-type'] ?? '').includes('application/json')) {
    const o = JSON.parse(text || '{}') as Record<string, unknown>
    return new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]))
  }
  return new URLSearchParams(text)
}

export async function oauthAndMcp(db: Db, req: IncomingMessage, res: ServerResponse, url: URL) {
  const p = url.pathname
  const open = (status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...OPEN, ...extra })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'OPTIONS' && p !== '/api/oauth/authorize') { res.writeHead(204, OPEN); return res.end() }
  try {
    if (req.method === 'GET' && p.startsWith('/.well-known/oauth-protected-resource')) return open(200, protectedResource(req))
    if (req.method === 'GET' && p.startsWith('/.well-known/oauth-authorization-server')) return open(200, authorizationServer(req))
    if (req.method === 'POST' && p === '/api/oauth/register') return open(201, await registerClient(db, req, JSON.parse((await bodyText(req, 64 * 1024)) || '{}') as Record<string, unknown>))
    if (req.method === 'GET' && p === '/api/oauth/authorize') return await authorizePage(db, req, res, url)
    if (req.method === 'POST' && p === '/api/oauth/authorize') return await authorizeDecision(db, req, res, await formOf(req))
    if (req.method === 'POST' && p === '/api/oauth/token') return open(200, await tokenEndpoint(db, req, await formOf(req)))
    if (req.method === 'POST' && p === '/api/oauth/revoke') { await revokeEndpoint(db, await formOf(req)); return open(200, {}) }
    if (p === '/api/mcp') {
      for (const [k, v] of Object.entries(OPEN)) res.setHeader(k, v)
      return await handleMcp(db, req, res)
    }
    return open(404, { error: 'not_found' })
  } catch (err) {
    if (err instanceof OAuthError) return open(err.status, { error: err.code, error_description: err.message })
    if (err instanceof SyntaxError) return open(400, { error: 'invalid_request', error_description: 'That isn’t valid JSON.' })
    throw err
  }
}

