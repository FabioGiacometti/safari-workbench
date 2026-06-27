import { notFound, badRequest } from './errors.js'
import * as events from './handlers/events.js'
import * as venues from './handlers/venues.js'
import * as discrepancies from './handlers/discrepancies.js'

/**
 * Dispatches to the correct handler based on path segments and HTTP method.
 * pathSegments comes from req.query._path split on '/'.
 *
 * Routes:
 *   GET    []                                  → events.list
 *   POST   []                                  → events.create  (body = event fields)
 *   GET    [id]                                → events.get
 *   PATCH  [id]                                → events.update
 *   POST   [id, 'publish']                     → events.publish
 *   POST   [id, 'cancel']                      → events.cancel
 *   GET    [id, 'audit']                       → events.audit
 *   GET    ['venues']                          → venues.list
 *   GET    ['venues', 'search']                → venues.search
 *   GET    ['venues', venueId, 'discrepancies']→ discrepancies.listForVenue
 *   GET    ['venues', id]  (id is UUID)        → venues.detail
 *   PATCH  ['venues', id]  (id is UUID)        → venues.update
 *   GET    ['discrepancies']                   → discrepancies.list
 *   POST   ['discrepancies', id, 'resolve']    → discrepancies.resolve
 */
export async function route(req, res, user, pathSegments) {
  const [seg0, seg1, seg2, seg3] = pathSegments
  const { method } = req

  // UUID pattern — used to distinguish /venues/:id from /venues/search
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  // /api/admin/discrepancies
  if (seg0 === 'discrepancies' && !seg1) {
    if (method !== 'GET') return badRequest(res, 'method_not_allowed')
    return discrepancies.list(req, res, user)
  }

  // /api/admin/discrepancies/:id/resolve
  if (seg0 === 'discrepancies' && seg1 && seg2 === 'resolve' && !seg3) {
    if (method !== 'POST') return badRequest(res, 'method_not_allowed')
    return discrepancies.resolve(req, res, user, seg1)
  }

  // /api/admin/venues  (list)
  if (seg0 === 'venues' && !seg1) {
    if (method !== 'GET') return badRequest(res, 'method_not_allowed')
    return venues.list(req, res, user)
  }

  // /api/admin/venues/search
  if (seg0 === 'venues' && seg1 === 'search' && !seg2) {
    if (method !== 'GET') return badRequest(res, 'method_not_allowed')
    return venues.search(req, res, user)
  }

  // /api/admin/venues/:venueId/discrepancies
  if (seg0 === 'venues' && seg1 && seg2 === 'discrepancies' && !seg3) {
    if (method !== 'GET') return badRequest(res, 'method_not_allowed')
    return discrepancies.listForVenue(req, res, user, seg1)
  }

  // /api/admin/venues/:id  (detail / update)
  if (seg0 === 'venues' && seg1 && !seg2 && UUID_RE.test(seg1)) {
    if (method === 'GET')   return venues.detail(req, res, user, seg1)
    if (method === 'PATCH') return venues.update(req, res, user, seg1)
    return badRequest(res, 'method_not_allowed')
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
