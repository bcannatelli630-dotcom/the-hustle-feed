// api/course.js — GolfCourseAPI middleman for The Hustle. Hides the API key from the phone.
//
// Requires: GOLFCOURSE_API_KEY env var (https://www.golfcourseapi.com).
//
//   GET /api/course?q=pebble   -> { courses: [ {id, name, location}, ... ] }   (1 API call, cached 1 day)
//   GET /api/course?id=12345   -> { course: {id, name, location, par, si, tees} } (1 API call, cached 7 days)
//
// GolfCourseAPI has a daily request limit, so search returns lightweight summaries
// only; full tee/hole data is fetched for the one course the user actually picks.
// Vercel's CDN caches successful responses, so repeat searches cost nothing.

import { createClient } from '@supabase/supabase-js';

const KEY = process.env.GOLFCOURSE_API_KEY;

// Permanent cache in the existing hustle_state table (rows keyed "course:<id>" and
// "search:<query>"), so a course or search is only ever fetched from GolfCourseAPI once.
let _sb;
function sb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _sb;
}
async function cacheGet(key) {
  const client = sb(); if (!client) return null;
  try {
    const { data } = await client.from('hustle_state').select('payload').eq('group_key', key).maybeSingle();
    return data && data.payload && data.payload.cached ? data.payload.cached : null;
  } catch (e) { return null; }
}
async function cachePut(key, value) {
  const client = sb(); if (!client) return;
  try {
    await client.from('hustle_state').upsert({ group_key: key, payload: { cached: value, t: Date.now() }, updated_at: new Date().toISOString() }, { onConflict: 'group_key' });
  } catch (e) { /* cache is best-effort */ }
}
const BASE = 'https://api.golfcourseapi.com';

class RateLimited extends Error {}

async function gcapi(path) {
  const resp = await fetch(`${BASE}${path}`, { headers: { Authorization: `Key ${KEY}` } });
  const text = await resp.text();
  if (resp.status === 429) throw new RateLimited(text.slice(0, 200));
  if (!resp.ok) throw new Error(`golfcourseapi_${resp.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { throw new Error(`golfcourseapi_bad_json: ${text.slice(0, 200)}`); }
}

function locationOf(c) {
  const loc = c.location || {};
  return [loc.city, loc.state].filter(Boolean).join(', ');
}

// Same-named clubs exist in different cities (e.g. San Jose Country Club in
// San Jose, CA and Jacksonville, FL), so the location is part of the name.
function displayName(c) {
  const sameName = !c.course_name || c.course_name.trim().toLowerCase() === (c.club_name || '').trim().toLowerCase();
  const base = `${c.club_name || c.course_name || 'Course'}${sameName ? '' : ' — ' + c.course_name}`;
  const location = locationOf(c);
  return location ? `${base} (${location})` : base;
}

function summary(c) {
  return { id: c.id, name: displayName(c), location: locationOf(c) };
}

function teeListOf(c) {
  const toList = s => !s ? [] : (Array.isArray(s) ? s : Object.values(s));
  return [...toList(c.tees && c.tees.male), ...toList(c.tees && c.tees.female)];
}

function detail(c) {
  const teeList = teeListOf(c);
  const holeTee = teeList.find(t => Array.isArray(t.holes) && t.holes.length >= 9) || teeList[0] || {};
  const holes = holeTee.holes || [];
  const tees = {};
  teeList.forEach(t => {
    const teeName = t.tee_name || t.name || 'Tee';
    if (tees[teeName]) return;
    tees[teeName] = { rating: t.course_rating, slope: t.slope_rating };
  });
  return { ...summary(c), par: holes.map(h => h.par), si: holes.map(h => h.handicap), tees };
}

const STOP = new Set(['golf', 'club', 'country', 'course', 'courses', 'the', 'and', 'links', 'resort', 'cc', 'gc']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!KEY) { res.status(500).json({ error: 'golfcourseapi_not_configured' }); return; }

  const id = (req.query && req.query.id || '').toString().trim();
  const q = (req.query && req.query.q || '').toString().trim();

  try {
    if (id) {
      const ckey = `course:${id}`;
      // refresh=1 ("Download & replace" in the app) skips the cache and overwrites it.
      const refresh = req.query && req.query.refresh;
      let course = refresh ? null : await cacheGet(ckey);
      if (!course) {
        const json = await gcapi(`/v1/courses/${encodeURIComponent(id)}`);
        course = detail(json.course || json);
        if (course.par && course.par.length) await cachePut(ckey, course);
      }
      res.setHeader('Cache-Control', refresh ? 'no-store' : 's-maxage=604800, stale-while-revalidate=86400');
      res.status(200).json({ course });
      return;
    }
    if (!q) { res.status(400).json({ error: 'missing_query' }); return; }

    const skey = `search:${q.toLowerCase()}`;
    const cachedSearch = await cacheGet(skey);
    if (cachedSearch) {
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
      res.status(200).json({ courses: cachedSearch });
      return;
    }

    const search = async s => ((await gcapi(`/v1/search?search_query=${encodeURIComponent(s)}`)).courses) || [];
    let raw = await search(q);
    // Squished names ("CordeValle" vs "Corde Valle").
    if (raw.length === 0 && /[a-z][A-Z]/.test(q)) raw = await search(q.replace(/([a-z])([A-Z])/g, '$1 $2'));
    // Multi-word query with no hit: try the most distinctive single word (one extra call max).
    if (raw.length === 0 && q.includes(' ')) {
      const words = q.split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w.toLowerCase()));
      const best = words.sort((a, b) => b.length - a.length)[0];
      if (best && best.toLowerCase() !== q.toLowerCase()) raw = await search(best);
    }

    const seen = new Set();
    const courses = raw.filter(c => c && !seen.has(c.id) && seen.add(c.id)).slice(0, 40).map(summary);
    if (courses.length) await cachePut(skey, courses);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    res.status(200).json({ courses });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof RateLimited) { res.status(429).json({ error: 'rate_limited' }); return; }
    console.error('course_lookup_failed:', e.message);
    res.status(502).json({ error: 'course_lookup_failed', detail: e.message });
  }
}
