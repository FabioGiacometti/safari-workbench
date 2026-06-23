// Sanitized HTTP error helpers for server-side API handlers.
// Never forward raw Supabase or DB error messages to the client.

export function badRequest(res, code = 'bad_request') {
  return res.status(400).json({ ok: false, error: code })
}

export function unauthorized(res, code = 'missing_token') {
  return res.status(401).json({ ok: false, error: code })
}

export function forbidden(res, code = 'not_authorized') {
  return res.status(403).json({ ok: false, error: code })
}

export function notFound(res, code = 'not_found') {
  return res.status(404).json({ ok: false, error: code })
}

export function conflict(res, code = 'conflict') {
  return res.status(409).json({ ok: false, error: code })
}

export function notImplemented(res, diagnostic = {}) {
  return res.status(501).json({ ok: false, error: 'not_implemented', ...diagnostic })
}

export function serverError(res, label, cause) {
  console.error(`[admin-api] ${label}:`, cause?.message ?? cause)
  return res.status(500).json({ ok: false, error: 'internal_server_error' })
}
