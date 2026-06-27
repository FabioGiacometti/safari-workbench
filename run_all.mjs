// Reads keys from .env.local, then runs probe + full acceptance matrix.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync(new URL('../../../../../../../../../projects/safari-workbench/.env.local', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const SUPABASE_URL  = env.VITE_SUPABASE_URL
const SK            = env.VITE_SUPABASE_KEY
const ANON_KEY      = env.VITE_SUPABASE_ANON_KEY

const BASE          = 'https://safari-workbench.vercel.app'
const TEST_VENUE_ID = 'cb099360-a384-493e-a8cf-2f9127bc35bf'

const svc  = createClient(SUPABASE_URL, SK,       { auth: { persistSession: false } })
const anon = createClient(SUPABASE_URL, ANON_KEY,  { auth: { persistSession: false } })

let pass = 0, fail = 0, warns = []
function ok(label, v, detail = '') {
  if (v) { console.log(`  PASS  ${label}${detail ? ' — '+detail : ''}`); pass++ }
  else   { console.log(`  FAIL  ${label}${detail ? ' — '+detail : ''}`); fail++; process.exitCode = 1 }
}
function warn(msg) { warns.push(msg); console.log(`  WARN  ${msg}`) }

// ═══════════════════════════════════════════════════════════════
// STEP 1: RPC PROBE (no token needed — uses service key directly)
// ═══════════════════════════════════════════════════════════════
console.log('\n══ 1. RPC installation probe ══')

const { data: probeData, error: probeErr } = await svc.rpc('edit_venue', {
  p_venue_id: '00000000-0000-0000-0000-000000000000',
  p_fields:   { city: 'probe' },
  p_actor:    'probe',
})
if (probeErr?.code === 'P0001' && (probeErr.message ?? '').includes('venue not found')) {
  ok('edit_venue exists and callable by service_role', true, 'P0001 "venue not found" — correct')
} else if (probeErr?.code === 'PGRST202') {
  console.error('FATAL: edit_venue not found in schema cache (PGRST202). Migration not applied.')
  process.exit(1)
} else if (probeErr) {
  ok('edit_venue callable', false, `${probeErr.code}: ${probeErr.message?.slice(0,80)}`)
} else {
  ok('edit_venue (unexpected success on zero-UUID)', false, JSON.stringify(probeData))
}

// anon blocked
const { error: anonProbeErr } = await anon.rpc('edit_venue', {
  p_venue_id: '00000000-0000-0000-0000-000000000000',
  p_fields:   { city: 'probe' },
  p_actor:    'probe',
})
const anonBlocked = anonProbeErr != null && (
  ['PGRST202','42501'].includes(anonProbeErr.code) ||
  (anonProbeErr.message ?? '').includes('permission denied') ||
  (anonProbeErr.message ?? '').includes('not found')
)
ok('anon role cannot invoke edit_venue', anonBlocked,
  anonProbeErr ? `${anonProbeErr.code}: ${anonProbeErr.message?.slice(0,60)}` : 'no error (BAD)')

// No data modified
const { count: vCount } = await svc.from('venues').select('*',{count:'exact',head:true})
ok('venues table accessible after migration', vCount > 0, `${vCount} rows`)
const { count: logCount0 } = await svc.from('venue_edit_log').select('*',{count:'exact',head:true})
ok('venue_edit_log accessible', logCount0 >= 0, `${logCount0} rows`)

// ═══════════════════════════════════════════════════════════════
// STEP 2: Get operator token
// ═══════════════════════════════════════════════════════════════
console.log('\n══ 2. Getting operator token ══')
const anonAuth  = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
const adminAuth = createClient(SUPABASE_URL, SK,        { auth: { persistSession: false } })

const { data: linkData, error: linkErr } = await adminAuth.auth.admin.generateLink({
  type: 'magiclink', email: 'fabiog.inbox@gmail.com',
})
if (linkErr) { console.error('generateLink failed:', linkErr); process.exit(1) }
const hashed_token = linkData.properties?.hashed_token
if (!hashed_token) { console.error('No hashed_token'); process.exit(1) }

const { data: sessionData, error: sessErr } = await anonAuth.auth.verifyOtp({
  type: 'magiclink', token_hash: hashed_token,
})
if (sessErr) { console.error('verifyOtp failed:', sessErr); process.exit(1) }
const TOKEN = sessionData.session?.access_token
if (!TOKEN) { console.error('No session token'); process.exit(1) }
console.log('  Token obtained (operator session)')

const h = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function api(method, path, body) {
  const opts = { method, headers: h }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const r = await fetch(`${BASE}/api/admin${path}`, opts)
  const text = await r.text()
  let parsed; try { parsed = JSON.parse(text) } catch { parsed = { _raw: text } }
  return { status: r.status, body: parsed }
}
const GET   = p       => api('GET',   p)
const PATCH = (p, b)  => api('PATCH', p, b)

// Token validity
const tokenChk = await GET('/discrepancies')
ok('Token valid against deployed API', tokenChk.status === 200, `status=${tokenChk.status}`)
if (tokenChk.status !== 200) { console.error('Token invalid against deployed API'); process.exit(1) }

// ═══════════════════════════════════════════════════════════════
// STEP 3: SNAPSHOT
// ═══════════════════════════════════════════════════════════════
console.log('\n══ 3. Pre-test snapshot ══')
const { data: snap, error: snapErr } = await svc
  .from('venues')
  .select('id,canonical_name,aliases,city,region,lat,lng,address,image_url,description,social_links,category,capacity,accessibility,manually_edited_fields,updated_at')
  .eq('id', TEST_VENUE_ID).single()
if (snapErr || !snap) { console.error('Cannot snapshot test venue:', snapErr?.message); process.exit(1) }

const { count: logPre0 } = await svc.from('venue_edit_log').select('*',{count:'exact',head:true}).eq('venue_id',TEST_VENUE_ID)
const { data: linkedEvts } = await svc.from('events').select('id,title,effective_lat,effective_lng,lat,lng').eq('venue_id',TEST_VENUE_ID).limit(5)

console.log('  canonical_name:', snap.canonical_name)
console.log('  city:', snap.city)
console.log('  lat/lng:', snap.lat, '/', snap.lng)
console.log('  aliases:', JSON.stringify(snap.aliases))
console.log('  capacity:', snap.capacity)
console.log('  description:', snap.description ?? null)
console.log('  address:', snap.address ?? null)
console.log('  image_url:', snap.image_url?.slice(0,60) ?? null)
console.log('  social_links:', JSON.stringify(snap.social_links))
console.log('  accessibility:', snap.accessibility ?? null)
console.log('  region:', snap.region ?? null)
console.log('  category:', snap.category ?? null)
console.log('  manually_edited_fields:', JSON.stringify(snap.manually_edited_fields))
console.log('  updated_at:', snap.updated_at)
console.log('  venue_edit_log rows (pre):', logPre0)
console.log('  linked events:')
for (const e of linkedEvts ?? []) {
  console.log(`    ${e.id.slice(0,8)} effective_lat=${e.effective_lat} effective_lng=${e.effective_lng}`)
}

// ═══════════════════════════════════════════════════════════════
// READS
// ═══════════════════════════════════════════════════════════════
console.log('\n══ R: Reads ══')

const r1 = await GET('/venues?limit=10&order=events')
ok('R1 venue list → 200', r1.status === 200, `${r1.body?.total} total`)
ok('R1 venues array', Array.isArray(r1.body?.venues))

const r2 = await GET('/venues?search=Teatro&limit=5')
ok('R2 search → 200', r2.status === 200)
ok('R2 results non-empty', (r2.body?.venues?.length ?? 0) > 0, `count=${r2.body?.venues?.length}`)

const r3 = await GET('/venues?city=C%C3%B3rdoba&limit=5')
ok('R3 city filter → 200', r3.status === 200)
ok('R3 results non-empty', (r3.body?.venues?.length ?? 0) > 0)

const r4 = await GET('/venues?limit=5&offset=5')
ok('R4 pagination → 200', r4.status === 200)
ok('R4 venues present', Array.isArray(r4.body?.venues))

const r5 = await GET(`/venues/${TEST_VENUE_ID}`)
ok('R5 detail → 200', r5.status === 200, `partial=${r5.body?.partial}`)
ok('R5 venue id matches', r5.body?.venue?.id === TEST_VENUE_ID)
ok('R5 events array', Array.isArray(r5.body?.events))
ok('R5 merge_history array', Array.isArray(r5.body?.merge_history))
ok('R5 mutations array', Array.isArray(r5.body?.mutations))
ok('R5 rules array', Array.isArray(r5.body?.rules))
ok('R5 partial=false', r5.body?.partial === false)

const r6 = await GET(`/venues/${TEST_VENUE_ID}/discrepancies`)
ok('R6 discrepancies → 200', r6.status === 200)
ok('R6 discrepancies array', Array.isArray(r6.body?.discrepancies))

const r7 = await GET('/venues/00000000-0000-0000-0000-000000000000')
ok('R7 unknown venue → 404', r7.status === 404)

// R8: auth gate fires before UUID validation.
// Unauthenticated → 401 (no token). Authenticated → 404 (no UUID match in router).
// 400 for malformed UUID is only reachable if explicit pre-auth UUID validation is added.
const r8_noauth = await fetch(`${BASE}/api/admin/venues/not-a-uuid`)
ok('R8 non-UUID without auth → 401', r8_noauth.status === 401, `got=${r8_noauth.status}`)
const r8_auth = await GET('/venues/not-a-uuid')
ok('R8 non-UUID with auth → 404 (no UUID match in router)', r8_auth.status === 404, `got=${r8_auth.status}`)

const r9 = await GET('/venues/search?q=Teatro&limit=3')
ok('R9 legacy /venues/search intact → 200', r9.status === 200, `count=${r9.body?.venues?.length}`)

// ═══════════════════════════════════════════════════════════════
// E1: TEXT EDIT (description)
// ═══════════════════════════════════════════════════════════════
console.log('\n══ E1: text edit (description) ══')
const testDesc = 'Teatro probe — TEMPORARY workbench acceptance test'
const e1 = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { description: testDesc } })
ok('E1 PATCH → 200', e1.status === 200, JSON.stringify(e1.body).slice(0,150))
ok('E1 changes=1', e1.body?.changes === 1)
ok('E1 venue in response', !!e1.body?.venue)
ok('E1 venue.description updated', e1.body?.venue?.description === testDesc)

const { data: e1db } = await svc.from('venues').select('description,updated_at,manually_edited_fields').eq('id',TEST_VENUE_ID).single()
ok('E1 DB description updated', e1db?.description === testDesc)
ok('E1 updated_at changed', e1db?.updated_at !== snap.updated_at, `was=${snap.updated_at} now=${e1db?.updated_at}`)
ok('E1 mef unchanged (description not pipeline-writable)',
  JSON.stringify(e1db?.manually_edited_fields) === JSON.stringify(snap.manually_edited_fields),
  `mef=${JSON.stringify(e1db?.manually_edited_fields)}`)

const { data: e1log } = await svc.from('venue_edit_log')
  .select('field_name,old_value,new_value,edited_by,source')
  .eq('venue_id',TEST_VENUE_ID).eq('field_name','description')
  .order('id',{ascending:false}).limit(1).single()
ok('E1 audit row inserted', !!e1log)
ok('E1 audit old=null (description was null)', e1log?.old_value === null, JSON.stringify(e1log?.old_value))
ok('E1 audit new={value:...}', e1log?.new_value?.value === testDesc, JSON.stringify(e1log?.new_value))
ok('E1 audit edited_by=operator', e1log?.edited_by === 'fabiog.inbox@gmail.com', e1log?.edited_by)
ok('E1 audit source=workbench', e1log?.source === 'workbench')

// ═══════════════════════════════════════════════════════════════
// E2: ALIASES
// ═══════════════════════════════════════════════════════════════
console.log('\n══ E2: aliases normalization ══')
const aliasInput = ['TDL', 'tdl', 'Teatro del Libertador', snap.canonical_name, '', '  ']
const e2 = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { aliases: aliasInput } })
ok('E2 → 200', e2.status === 200, JSON.stringify(e2.body).slice(0,150))
const e2arr = e2.body?.venue?.aliases ?? []
ok('E2 case-dup removed (tdl deduped against TDL)', !e2arr.map(a=>a.toLowerCase()).includes('tdl') || e2arr.filter(a=>a.toLowerCase()==='tdl').length === 1, JSON.stringify(e2arr))
ok('E2 canonical_name removed', !e2arr.some(a => a.toLowerCase() === snap.canonical_name.toLowerCase()), JSON.stringify(e2arr))
ok('E2 empty strings removed', !e2arr.includes('') && !e2arr.includes('  '))
ok('E2 aliases in mef (pipeline-writable)', (e2.body?.venue?.manually_edited_fields ?? []).includes('aliases'),
  JSON.stringify(e2.body?.venue?.manually_edited_fields))

const { data: e2log } = await svc.from('venue_edit_log')
  .select('field_name,old_value,new_value,edited_by')
  .eq('venue_id',TEST_VENUE_ID).eq('field_name','aliases')
  .order('id',{ascending:false}).limit(1).single()
ok('E2 audit row inserted', !!e2log, JSON.stringify(e2log))
ok('E2 edited_by=operator', e2log?.edited_by === 'fabiog.inbox@gmail.com')

// ═══════════════════════════════════════════════════════════════
// E3: CAPACITY
// ═══════════════════════════════════════════════════════════════
console.log('\n══ E3: capacity ══')
const e3f = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { capacity: 1500.5 } })
ok('E3a fractional → 400', e3f.status === 400, `err=${e3f.body?.error}`)
ok('E3a error=invalid_value', e3f.body?.error === 'invalid_value')

const e3n = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { capacity: -1 } })
ok('E3b negative → 400', e3n.status === 400)

const e3ok = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { capacity: 2500 } })
ok('E3c valid int → 200', e3ok.status === 200, `capacity=${e3ok.body?.venue?.capacity}`)
ok('E3c capacity=2500', e3ok.body?.venue?.capacity === 2500)

// ═══════════════════════════════════════════════════════════════
// E4: SOCIAL_LINKS
// ═══════════════════════════════════════════════════════════════
console.log('\n══ E4: social_links ══')
const e4bad = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { social_links: 'not-object' } })
ok('E4a non-object → 400', e4bad.status === 400, `err=${e4bad.body?.error}`)

const e4ok = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { social_links: { instagram: '@teatrolibertador_test' } } })
ok('E4b object → 200', e4ok.status === 200)
ok('E4b instagram stored', e4ok.body?.venue?.social_links?.instagram === '@teatrolibertador_test')

// ═══════════════════════════════════════════════════════════════
// E5: EMPTY STRING / NULL normalization
// ═══════════════════════════════════════════════════════════════
console.log('\n══ E5: null/empty normalization ══')
// accessibility is currently null — sending empty string should be a no-op (both normalize to null)
const e5 = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { accessibility: '' } })
if (e5.status === 409 && e5.body?.error === 'no_changes') {
  ok('E5 empty string = null (no-op confirmed)', true, 'accessibility already null, empty→null treated as no change')
} else if (e5.status === 200) {
  ok('E5 empty string accepted (server normalized)', true)
  const { data: e5db } = await svc.from('venues').select('accessibility').eq('id',TEST_VENUE_ID).single()
  ok('E5 accessibility=null after empty string', e5db?.accessibility === null, `got=${e5db?.accessibility}`)
} else {
  ok('E5 empty/null normalization', false, `status=${e5.status} body=${JSON.stringify(e5.body).slice(0,100)}`)
}

// ═══════════════════════════════════════════════════════════════
// E6: COORDINATES
// ═══════════════════════════════════════════════════════════════
console.log('\n══ E6: coordinates ══')

// E6a: venue already has both lat+lng. Sending only lat is valid — the persisted lng
// completes the pair. Rejection (invalid_coordinates) only fires when the *resulting*
// stored state would have exactly one null coordinate (first-time setup).
const e6p = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { lat: -31.5 } })
ok('E6a lat-only on venue with existing lng → 200 (valid final pair)', e6p.status === 200, `err=${e6p.body?.error}`)
// Restore the lat change immediately before continuing
if (e6p.status === 200) {
  await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { lat: snap.lat } })
}

// E6b: out-of-range value → 400 with error=invalid_value (range check, not pair check)
const e6oor = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { lat: 91, lng: -64.0 } })
ok('E6b out-of-range lat → 400', e6oor.status === 400, `err=${e6oor.body?.error}`)
ok('E6b error=invalid_value (range check, not pair check)', e6oor.body?.error === 'invalid_value', e6oor.body?.error)

const newLat = Number((snap.lat + 0.001).toFixed(7))
const newLng = Number((snap.lng + 0.001).toFixed(7))
const e6ok = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { lat: newLat, lng: newLng } })
ok('E6c valid pair → 200', e6ok.status === 200, JSON.stringify(e6ok.body).slice(0,150))
ok('E6c lat in response', Math.abs((e6ok.body?.venue?.lat ?? 0) - newLat) < 0.0001, `got=${e6ok.body?.venue?.lat}`)

const { data: vCoord } = await svc.from('venues').select('lat,lng').eq('id',TEST_VENUE_ID).single()
ok('E6c DB lat updated', Math.abs((vCoord?.lat ?? 0) - newLat) < 0.0001, `db_lat=${vCoord?.lat}`)

// Coordinate propagation to events
const { data: evtsCoord } = await svc.from('events').select('id,effective_lat,effective_lng').eq('venue_id',TEST_VENUE_ID).limit(3)
if (evtsCoord?.length) {
  for (const e of evtsCoord) {
    const latOk = Math.abs((e.effective_lat ?? 0) - newLat) < 0.001
    const lngOk = Math.abs((e.effective_lng ?? 0) - newLng) < 0.001
    ok(`E6c coord propagated to event ${e.id.slice(0,8)}`, latOk && lngOk,
      `eff_lat=${e.effective_lat} eff_lng=${e.effective_lng} expected≈${newLat},${newLng}`)
  }
} else { warn('E6c no linked events to verify coordinate propagation') }

// ═══════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════
console.log('\n══ S: Security and state ══')

const s1 = await fetch(`${BASE}/api/admin/venues/${TEST_VENUE_ID}`)
ok('S1 no token → 401', s1.status === 401)

const s2 = await fetch(`${BASE}/api/admin/venues/${TEST_VENUE_ID}`, { headers: { Authorization: 'Bearer bad.jwt.token' } })
ok('S2 bad token → 401', s2.status === 401)

const s3 = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { bad_field: 'x' } })
ok('S3 unknown field → 400', s3.status === 400)
ok('S3 error=unknown_field', s3.body?.error === 'unknown_field', s3.body?.error)
ok('S3 field returned', s3.body?.field === 'bad_field', `field=${s3.body?.field}`)

const s4 = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: {} })
ok('S4 empty patch → 400', s4.status === 400)

// no-op: send current capacity value
const { data: currCap } = await svc.from('venues').select('capacity').eq('id',TEST_VENUE_ID).single()
const s5 = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { capacity: currCap?.capacity } })
ok('S5 no-op → 409', s5.status === 409, `err=${s5.body?.error}`)
ok('S5 error=no_changes', s5.body?.error === 'no_changes')

const s6 = await PATCH('/venues/00000000-0000-0000-0000-000000000000', { fields: { city: 'x' } })
ok('S6 missing venue → 404', s6.status === 404)

// Actor spoofing
const beforeSpoof = await svc.from('venue_edit_log').select('edited_by').eq('venue_id',TEST_VENUE_ID).order('id',{ascending:false}).limit(1).single()
const s7 = await PATCH(`/venues/${TEST_VENUE_ID}`, {
  fields: { description: 'Spoofed test' },
  actor: 'evil-actor',
  resolved_by: 'hacker@evil.com',
})
ok('S7 request with spoofed actor fields accepted (ignored)', s7.status === 200 || s7.status === 409, `status=${s7.status}`)
if (s7.status === 200) {
  const { data: spoof } = await svc.from('venue_edit_log').select('edited_by').eq('venue_id',TEST_VENUE_ID).order('id',{ascending:false}).limit(1).single()
  ok('S7 edited_by=operator (not spoofed)', spoof?.edited_by === 'fabiog.inbox@gmail.com', spoof?.edited_by)
}

// anon direct RPC call
const s8 = await fetch(`${SUPABASE_URL}/rest/v1/rpc/edit_venue`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
  body: JSON.stringify({ p_venue_id: '00000000-0000-0000-0000-000000000000', p_fields: { city: 'x' }, p_actor: 'anon' })
})
ok('S8 anon direct RPC call blocked', s8.status === 404 || s8.status === 401 || s8.status === 403,
  `status=${s8.status}`)

// ═══════════════════════════════════════════════════════════════
// ATOMICITY
// ═══════════════════════════════════════════════════════════════
console.log('\n══ A1: atomicity (intentional failure) ══')
const { data: atomPre } = await svc.from('venues').select('city,updated_at,manually_edited_fields').eq('id',TEST_VENUE_ID).single()
const { count: logAtomPre } = await svc.from('venue_edit_log').select('*',{count:'exact',head:true}).eq('venue_id',TEST_VENUE_ID)

// city is valid but capacity is fractional — whole PATCH must fail
const a1 = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: { city: 'AtomicTestFail', capacity: 99.9 } })
ok('A1 mixed valid+invalid → 400', a1.status === 400, `err=${a1.body?.error}`)

const { data: atomPost } = await svc.from('venues').select('city,updated_at,manually_edited_fields').eq('id',TEST_VENUE_ID).single()
const { count: logAtomPost } = await svc.from('venue_edit_log').select('*',{count:'exact',head:true}).eq('venue_id',TEST_VENUE_ID)

ok('A1 city NOT changed', atomPost?.city !== 'AtomicTestFail', `city=${atomPost?.city}`)
ok('A1 updated_at unchanged', atomPost?.updated_at === atomPre?.updated_at)
ok('A1 no log rows inserted', logAtomPost === logAtomPre, `pre=${logAtomPre} post=${logAtomPost}`)
ok('A1 mef unchanged', JSON.stringify(atomPost?.manually_edited_fields) === JSON.stringify(atomPre?.manually_edited_fields))

// ═══════════════════════════════════════════════════════════════
// RESTORE
// ═══════════════════════════════════════════════════════════════
console.log('\n══ Restore original values ══')

const EDITABLE = ['canonical_name','aliases','city','region','lat','lng','address','image_url',
                  'description','social_links','category','capacity','accessibility']
const restoreFields = {}
for (const f of EDITABLE) { restoreFields[f] = snap[f] ?? null }

const restore = await PATCH(`/venues/${TEST_VENUE_ID}`, { fields: restoreFields })
ok('Restore PATCH → 200 or 409', restore.status === 200 || restore.status === 409,
  `status=${restore.status} body=${JSON.stringify(restore.body).slice(0,150)}`)

const { data: finalVenue } = await svc.from('venues')
  .select('canonical_name,aliases,city,region,lat,lng,address,image_url,description,social_links,category,capacity,accessibility,manually_edited_fields,updated_at')
  .eq('id',TEST_VENUE_ID).single()

let restoreOk = true
for (const f of EDITABLE) {
  const a = JSON.stringify(snap[f] ?? null)
  const b = JSON.stringify(finalVenue[f] ?? null)
  if (a !== b) { ok(`Restore ${f}`, false, `expected=${a} got=${b}`); restoreOk = false }
  else ok(`Restore ${f}`, true)
}

// Coordinate propagation after restore
const { data: evtsRestored } = await svc.from('events').select('id,effective_lat,effective_lng').eq('venue_id',TEST_VENUE_ID).limit(3)
if (evtsRestored?.length && linkedEvts?.length) {
  const origE = linkedEvts[0], restoredE = evtsRestored[0]
  ok('Restore: effective_lat back', Math.abs((restoredE.effective_lat??0)-(origE.effective_lat??0)) < 0.0001,
    `restored=${restoredE.effective_lat} original=${origE.effective_lat}`)
  ok('Restore: effective_lng back', Math.abs((restoredE.effective_lng??0)-(origE.effective_lng??0)) < 0.0001)
}

// ═══════════════════════════════════════════════════════════════
// FINAL LOG COUNT
// ═══════════════════════════════════════════════════════════════
const { count: logFinal } = await svc.from('venue_edit_log').select('*',{count:'exact',head:true}).eq('venue_id',TEST_VENUE_ID)
console.log(`\n  venue_edit_log rows for test venue: pre=${logPre0} post=${logFinal} (delta=${logFinal-logPre0} audit entries added)`)

if (warns.length) { console.log('\n══ Warnings ══'); warns.forEach(w => console.log(' ', w)) }
console.log(`\n━━━ ${pass} passed  ${fail} failed ━━━`)
