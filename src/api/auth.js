import { getAuthClient } from './supabaseServer.js'
import { unauthorized, forbidden } from './errors.js'

// Operators who may access privileged API routes.
// Adding an operator requires a code change and redeploy.
// This list is server-only — never exposed to the browser.
const OPERATOR_EMAILS = ['fabiog.inbox@gmail.com']

/**
 * Validates the Bearer token in the Authorization header against the Supabase
 * Auth server (real network call — not local JWT decode), then checks the
 * verified email against the operator allowlist.
 *
 * Returns the verified Supabase user object on success.
 * Calls res.status(...).json(...) and returns null on failure — caller must
 * check for null and return immediately.
 *
 * Actor identity comes exclusively from user.email returned here.
 * Never accept actor/created_by/published_by from the request body.
 */
export async function requireOperator(req, res) {
  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null

  if (!token) {
    unauthorized(res, 'missing_token')
    return null
  }

  const authClient = getAuthClient()
  const { data: { user }, error } = await authClient.auth.getUser(token)

  if (error || !user) {
    unauthorized(res, 'invalid_token')
    return null
  }

  if (!OPERATOR_EMAILS.includes(user.email)) {
    forbidden(res, 'not_authorized')
    return null
  }

  return user
}
