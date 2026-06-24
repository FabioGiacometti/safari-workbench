// Single handler for all /api/admin/* routes.
//
// Reached two ways:
//   - GET/POST /api/admin       → direct filesystem match (_path absent)
//   - /api/admin/:path*         → vercel.json rewrite sets _path query param
//
// All business logic lives in src/api/ — this file stays thin.

import { requireOperator } from '../src/api/auth.js'
import { serverError } from '../src/api/errors.js'
import { route } from '../src/api/router.js'

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
  if (!user) return // requireOperator already sent 401/403

  // Path segments from rewrite param: "events/test-id/publish" → ["events","test-id","publish"]
  const raw = req.query._path ?? ''
  const pathSegments = raw ? raw.split('/').filter(Boolean) : []

  try {
    await route(req, res, user, pathSegments)
  } catch (err) {
    serverError(res, 'unhandled route error', err)
  }
}
