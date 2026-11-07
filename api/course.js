// api/course.js — GolfCourseAPI middleman for The Hustle. Hides the API key from the phone,
// normalizes the response to what the app's course-search UI expects.
//
// Requires: GOLFCOURSE_API_KEY env var (https://www.golfcourseapi.com).
// Usage: GET /api/course?q=pebble  ->  { courses: [ { name, par:[18], si:[18], tees:{...} }, ... ] }

const KEY = process.env.GOLFCOURSE_API_KEY;
const BASE = 'https://api.golfcourseapi.com';

async function searchGolfCourseAPI(q) {
  const resp = await fetch(`${BASE}/v1/search?search_query=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Key ${KEY}` }
  });
  const text = await resp.text();
  if (!resp.ok) {
    // Surface GolfCourseAPI's own status/body instead of blindly calling .json()
    // on what might be an HTML error page or empty body (that throw was what
    // turned an ordinary "bad key" / rate-limit response into an opaque 502).
    throw new Error(`golfcourseapi_${resp.status}: ${text.slice(0, 200)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`golfcourseapi_bad_json: ${text.slice(0, 200)}`); }
  return json.courses || [];
}

// Search results are sometimes summary records with no tees/holes. The full
// record (tees, par, stroke index) only comes back from /v1/courses/{id}.
async function fetchCourseDetail(id) {
  const resp = await fetch(`${BASE}/v1/courses/${id}`, { headers: { Authorization: `Key ${KEY}` } });
  if (!resp.ok) return null;
  try { const j = await resp.json(); return j.course || j; } catch (e) { return null; }
}

function teeListOf(c) {
  const toList = s => !s ? [] : (Array.isArray(s) ? s : Object.values(s));
  // Male tees first, then female, so every tee the course has is selectable.
  return [...toList(c.tees && c.tees.male), ...toList(c.tees && c.tees.female)];
}

function hasHoleData(c) {
  return teeListOf(c).some(t => Array.isArray(t.holes) && t.holes.length >= 9);
}

function normalize(c) {
  const teeList = teeListOf(c);
  // Use the first tee that actually carries hole-by-hole data, not just the first tee.
  const holeTee = teeList.find(t => Array.isArray(t.holes) && t.holes.length >= 9) || teeList[0] || {};
  const holes = holeTee.holes || [];
  const tees = {};
  teeList.forEach(t => {
    const teeName = t.tee_name || t.name || 'Tee';
    if (tees[teeName]) return; // male + female sets can share names; keep the first
    tees[teeName] = { rating: t.course_rating, slope: t.slope_rating };
  });
  return {
    name: `${c.club_name}${c.course_name ? ' — ' + c.course_name : ''}`,
    par: holes.map(h => h.par),
    si: holes.map(h => h.handicap),
    tees
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!KEY) { res.status(500).json({ error: 'golfcourseapi_not_configured' }); return; }

  const q = (req.query && req.query.q || '').trim();
  if (!q) { res.status(400).json({ error: 'missing_query' }); return; }

  try {
    let raw = await searchGolfCourseAPI(q);

    // GolfCourseAPI's match can be strict about camelCase / no-space club names
    // ("CordeValle" vs. their stored "Corde Valle"). If the exact query comes up
    // empty and it looks like a squished multi-word name, retry with a spaced-out
    // version and with just the first significant word before giving up.
    if (raw.length === 0 && /[a-z][A-Z]/.test(q)) {
      const spaced = q.replace(/([a-z])([A-Z])/g, '$1 $2');
      raw = await searchGolfCourseAPI(spaced);
    }
    if (raw.length === 0 && q.includes(' ')) {
      const firstWord = q.split(' ')[0];
      if (firstWord.length >= 3) raw = await searchGolfCourseAPI(firstWord);
    }

    const top = raw.slice(0, 8);
    // Fill in any summary-only results with the full course record.
    const full = await Promise.all(top.map(async c => {
      if (hasHoleData(c) || !c.id) return c;
      const d = await fetchCourseDetail(c.id);
      return d && hasHoleData(d) ? d : c;
    }));
    const courses = full.map(normalize);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    res.status(200).json({ courses });
  } catch (e) {
    console.error('course_lookup_failed:', e.message);
    res.status(502).json({ error: 'course_lookup_failed', detail: e.message });
  }
}

