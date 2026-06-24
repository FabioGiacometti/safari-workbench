import { notFound, badRequest } from './errors.js'
import * as events from './handlers/events.js'
import * as venues from './handlers/venues.js'

/**
 * Dispatches to the correct handler based on path segments and HTTP method.
 * pathSegments comes from req.query._path split on '/'.
 *
 * Routes:
 *   GET    []                        → events.list
 *   POST   []                        → events.create  (body = event fields)
 *   GET    [id]                      → events.get
 *   PATCH  [id]                      → events.update
 *   POST   [id, 'publish']           → events.publish
 *   POST   [id, 'cancel']            → events.cancel
 *   GET    [id, 'audit']             → events.audit
 *   GET    ['venues', 'search']      → venues.search
 */
export async function route(req, res, user, pathSegments) {
  const [seg0, seg1, seg2] = pathSegments
  const { method } = req

  // /api/admin/venues/search
  if (seg0 === 'venues' && seg1 === 'search' && !seg2) {
    if (method !== 'GET') return badRequest(res, 'method_not_allowed')
    return venues.search(req, res, user)
  }

  // /api/admin  (event list + create)
  if (!seg0) {
    if (method === 'GET')  return events.list(req, res, user)
    if (method === 'POST') return events.create(req, res, user)
    return badRequest(res, 'method_not_allowed')
  }

  // /api/admin/events  — kept for explicit /events sub-path
  if (seg0 === 'events' && !seg1) {
    if (method === 'GET')  return events.list(req, res, user)
    if (method === 'POST') return events.create(req, res, user)
    return badRequest(res, 'method_not_allowed')
  }

  // /api/admin/events/:id  or  /api/admin/:id
  const id = (seg0 === 'events' && seg1) ? seg1 : (seg0 !== 'venues' ? seg0 : null)
  const action = (seg0 === 'events' && seg1) ? seg2 : (seg0 !== 'venues' ? seg1 : null)

  if (!id) return notFound(res)

  if (!action) {
    if (method === 'GET')   return events.get(req, res, user, id)
    if (method === 'PATCH') return events.update(req, res, user, id)
    return badRequest(res, 'method_not_allowed')
  }

  if (action === 'publish' && method === 'POST') return events.publish(req, res, user, id)
  if (action === 'cancel'  && method === 'POST') return events.cancel(req, res, user, id)
  if (action === 'audit'   && method === 'GET')  return events.audit(req, res, user, id)

  return notFound(res)
}
