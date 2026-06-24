// Single handler for all /api/admin/* routes.
//
// Reached two ways:
//   - GET/POST /api/admin  → direct filesystem match (req.query._path undefined)
//   - /api/admin/*         → vercel.json rewrite passes path as _path query param
//
// Step A spike — diagnostic responses only. No database writes.

import { requireOperator } from '../src/api/auth.js'
import { serverError } from '../src/api/errors.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
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

  // Path comes from the rewrite _path param: "events/test-id/publish" → split to array
  const raw = req.query._path ?? ''
  const pathSegments = raw ? raw.split('/').filter(Boolean) : []

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
