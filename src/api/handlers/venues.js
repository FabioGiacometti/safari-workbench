import { getAdminClient } from '../supabaseServer.js'
import { serverError, badRequest } from '../errors.js'

export async function search(req, res, _user) {
  const q = (req.query.q ?? '').trim()
  const limit = Math.min(parseInt(req.query.limit ?? '20', 10) || 20, 50)

  if (!q) return badRequest(res, 'missing_q')

  const db = getAdminClient()

  const { data, error } = await db
    .from('venues')
    .select('id, canonical_name, city, lat, lng, merged_into')
    .is('merged_into', null)
    .not('lat', 'is', null)
    .ilike('canonical_name', `%${q}%`)
    .limit(limit)

  if (error) return serverError(res, 'venue search failed', error)

  res.status(200).json({ ok: true, venues: data })
}
