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
  const json = await resp.json();
  return json.courses || [];
}

function normalize(c) {
  const holes = (c.tees && c.tees.male && c.tees.male[0] && c.tees.male[0].holes)
    || (c.tees && c.tees.female && c.tees.female[0] && c.tees.female[0].holes) || [];
  const tees = {};
  const teeList = (c.tees && (c.tees.male || c.tees.female)) || [];
  teeList.forEach(t => { tees[t.tee_name] = { rating: t.course_rating, slope: t.slope_rating }; });
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

    const courses = raw.slice(0, 8).map(normalize);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    res.status(200).json({ courses });
  } catch (e) {
    res.status(502).json({ error: 'course_lookup_failed' });
  }
}

