// api/course.js — GolfCourseAPI middleman for The Hustle. Hides the API key from the phone,
// normalizes the response to what the app's course-search UI expects.
//
// Requires: GOLFCOURSE_API_KEY env var (https://www.golfcourseapi.com).
// Usage: GET /api/course?q=pebble  ->  { courses: [ { name, par:[18], si:[18], tees:{...} }, ... ] }

const KEY = process.env.GOLFCOURSE_API_KEY;
const BASE = 'https://api.golfcourseapi.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!KEY) { res.status(500).json({ error: 'golfcourseapi_not_configured' }); return; }

  const q = (req.query && req.query.q || '').trim();
  if (!q) { res.status(400).json({ error: 'missing_query' }); return; }

  try {
    const searchResp = await fetch(`${BASE}/v1/search?search_query=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Key ${KEY}` }
    });
    const searchJson = await searchResp.json();
    const courses = (searchJson.courses || []).slice(0, 8).map(c => {
      const holes = (c.tees && c.tees.male && c.tees.male[0] && c.tees.male[0].holes) || [];
      const tees = {};
      const teeList = (c.tees && c.tees.male) || [];
      teeList.forEach(t => { tees[t.tee_name] = { rating: t.course_rating, slope: t.slope_rating }; });
      return {
        name: `${c.club_name}${c.course_name ? ' — ' + c.course_name : ''}`,
        par: holes.map(h => h.par),
        si: holes.map(h => h.handicap),
        tees
      };
    });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    res.status(200).json({ courses });
  } catch (e) {
    res.status(502).json({ error: 'course_lookup_failed' });
  }
}
