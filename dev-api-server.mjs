/**
 * Local dev API server — loads .env.local and serves /api/* routes.
 * Replaces `vercel dev` for local development.
 *
 * Usage:  node dev-api-server.mjs
 * Port:   3001  (Vite proxies /api → here)
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { parse as parseUrl } from 'node:url'
import { parse as parseQs } from 'node:querystring'

// ---------------------------------------------------------------------------
// Load .env.local before importing any app modules that read process.env
// ---------------------------------------------------------------------------
try {
  const raw = readFileSync('.env.local', 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    // Don't overwrite vars already set in the shell environment
    if (!(key in process.env)) process.env[key] = val
  }
  console.log('[dev-api] Loaded .env.local')
} catch {
  console.warn('[dev-api] .env.local not found — relying on shell env')
}

// ---------------------------------------------------------------------------
// Import admin handler (after env is loaded)
// ---------------------------------------------------------------------------
const { default: adminHandler } = await import('./api/admin.js')
const { default: healthHandler } = await import('./api/health.js')

// ---------------------------------------------------------------------------
// Minimal request/response shim (mirrors what Vercel passes to handlers)
// ---------------------------------------------------------------------------
function makeReq(nodeReq, parsedUrl, body) {
  const query = Object.fromEntries(
    Object.entries(parseQs(parsedUrl.query ?? '')).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  )

  // Simulate Vercel rewrite: /api/admin/foo/bar → _path=foo/bar
  // /api/admin → _path="" (or absent)
  const pathname = parsedUrl.pathname ?? '/'
  const adminPrefix = '/api/admin'
  if (pathname.startsWith(adminPrefix)) {
    const rest = pathname.slice(adminPrefix.length).replace(/^\//, '')
    if (rest) query._path = rest
  }

  return {
    method: nodeReq.method,
    headers: nodeReq.headers,
    url: nodeReq.url,
    query,
    body,
  }
}

function makeRes(nodeRes) {
  const res = {
    _headers: {},
    _statusCode: 200,
    status(code) { res._statusCode = code; return res },
    setHeader(k, v) { nodeRes.setHeader(k, v); return res },
    json(data) {
      nodeRes.setHeader('Content-Type', 'application/json')
      nodeRes.writeHead(res._statusCode)
      nodeRes.end(JSON.stringify(data))
    },
    end(data) {
      nodeRes.writeHead(res._statusCode)
      nodeRes.end(data)
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer(async (nodeReq, nodeRes) => {
  // CORS for local dev
  nodeRes.setHeader('Access-Control-Allow-Origin', 'http://localhost:5174')
  nodeRes.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  nodeRes.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (nodeReq.method === 'OPTIONS') {
    nodeRes.writeHead(204)
    nodeRes.end()
    return
  }

  // Read body
  let body = {}
  const rawBody = await new Promise((resolve) => {
    const chunks = []
    nodeReq.on('data', c => chunks.push(c))
    nodeReq.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
  if (rawBody && nodeReq.headers['content-type']?.includes('application/json')) {
    try { body = JSON.parse(rawBody) } catch { /* ignore */ }
  }

  const parsedUrl = parseUrl(nodeReq.url)
  const pathname = parsedUrl.pathname ?? '/'

  const req = makeReq(nodeReq, parsedUrl, body)
  const res = makeRes(nodeRes)

  console.log(`[dev-api] ${nodeReq.method} ${pathname}`)

  if (pathname === '/api/health') {
    return healthHandler(req, res)
  }
  if (pathname.startsWith('/api/admin')) {
    return adminHandler(req, res)
  }

  nodeRes.writeHead(404)
  nodeRes.end(JSON.stringify({ error: 'not_found' }))
})

const PORT = 3001
server.listen(PORT, () => {
  console.log(`[dev-api] Listening on http://localhost:${PORT}`)
  console.log('[dev-api] SUPABASE_URL:', process.env.SUPABASE_URL ? '✓' : '✗ MISSING')
  console.log('[dev-api] SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? '✓' : '✗ MISSING')
  console.log('[dev-api] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓' : '✗ MISSING')
})
