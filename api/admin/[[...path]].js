// Single catch-all handler for all /api/admin/* routes.
// [[...path]] = optional catch-all: matches /api/admin and /api/admin/**
//
// Step A spike — diagnostic responses only. No database writes.

import { requireOperator } from '../../src/api/auth.js'
import { serverError } from '../../src/api/errors.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  // CORS: Workbench is same-origin in production; allow * for local vercel dev.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN ?? '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  let user
  try {
    user = await requireOperator(req, res)
  } catch (err) {
    serverError(res, 'requireOperator threw', err)
    return
  }
  if (!user) return // requireOperator already sent the 401/403

  // Catch-all path segments (may be undefined at the base /api/admin route)
  const pathSegments = Array.isArray(req.query.path)
    ? req.query.path
    : req.query.path
      ? [req.query.path]
      : []

  // Diagnostic response — no DB access, no side effects
  res.status(501).json({
    ok: false,
    error: 'not_implemented',
    diagnostic: {
      method: req.method,
      pathSegments,
      operator: user.email,
    },
  })
}
