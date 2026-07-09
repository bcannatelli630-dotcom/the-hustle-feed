# The Hustle — Slash-Golf-style middleman (developer one-pager)

Mirrors the pattern used by the Mickeltitties Cup app: the phone app (`The Hustle.dc.html` +
`support.js`) is a static site with no backend of its own. This small folder is the
"middleman" — it holds your secret keys, talks to Supabase (shared match state) and
GolfCourseAPI (course/tee data), and hands the app clean JSON. **Total job: ~1 hour.**

## What's in this folder
- `api/state.js` — shared match state, GET to read / POST to write. One JSON blob per group
  (roster, active event, scores, games, junk, presses, greenies, RRC, history) stored as a row
  in Supabase. Every player's phone reads and writes here — this is what makes standings update
  live for everyone.
- `api/course.js` — course search + tee lookup, proxied through GolfCourseAPI so the app never
  sees your API key. Powers the "Change Course" search in Settings.
- `package.json` — one dependency: `@supabase/supabase-js`.
- `vercel.json` — deploy config.
- `.env.example` — the three secrets you set.

## Deploy (Vercel, free tier is fine)
1. Create a free Supabase project at supabase.com. In the SQL editor, run:
   ```sql
   create table hustle_state (
     group_key text primary key,
     payload jsonb not null,
     updated_at timestamptz not null default now()
   );
   ```
   That's the entire schema — one row per friend group, holding the whole app's live state as JSON
   (same shape the app already keeps in memory: roster, course, event, scores, games, junk,
   greenieWinners, rrcHolder, presses, history). Simple on purpose, same idea as Mickeltitties'
   Redis blob — just swapped to Supabase per your call.
2. `npm i -g vercel`, then run `vercel` in this folder (or drag the folder into the Vercel
   dashboard) to create the project.
3. In Vercel → Project → Settings → Environment Variables, add:
   - `SUPABASE_URL` — Project Settings → API → Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → service_role key (server-only, never
     shipped to the phone)
   - `GOLFCOURSE_API_KEY` — from golfcourseapi.com
   - `HUSTLE_WRITE_KEY` — any password your group agrees on (defaults to `hustle-2026` if unset;
     this replaces the removed Settings password gate at the transport level — a phone can't write
     scores without it)
4. Redeploy. You now have two live URLs:
   - `https://<your-project>.vercel.app/api/state?group=usual-suspects`
   - `https://<your-project>.vercel.app/api/course?q=pebble`

## Point the app at it
In `The Hustle.dc.html`'s logic class, near the top, set:
```js
SYNC_ENDPOINT = 'https://<your-project>.vercel.app/api/state';
COURSE_ENDPOINT = 'https://<your-project>.vercel.app/api/course';
GROUP_KEY = 'usual-suspects';   // any slug your group agrees on
USE_LIVE_SYNC = true;
```
`loadState()` / `pushState()` are already stubbed in the logic class with the exact request/response
shape `api/state.js` expects — flipping `USE_LIVE_SYNC` on and filling in the three constants above
is the whole integration. Poll interval lives next to those constants (default 4s, matches how
often golfers actually re-check a leaderboard).

## Put it on thehustleapp.net
1. Deploy the app repo (`The Hustle.dc.html` + `support.js`, as static files — same as
   `mickeltitties-app`) as its own Vercel project.
2. Buy/point `thehustleapp.net` at Vercel: Vercel Project → Settings → Domains → Add
   `thehustleapp.net` → follow the DNS instructions it gives you (either transfer nameservers to
   Vercel, or add the A/CNAME records it shows at your registrar). Propagation is usually
   minutes, sometimes a few hours.
3. Repeat step 3 above (env vars) on the app project too if you want the sync constants injected
   at build time instead of hardcoded — optional, hardcoding is fine for a private group app.

## Gotchas
- **CORS** is set to `*` for simplicity in both endpoints; lock to `https://thehustleapp.net` once
  live if you want to be strict.
- **Rate limits**: GolfCourseAPI calls are cached for an hour (`s-maxage=3600`) since course data
  barely changes.
- **State writes are last-write-wins.** Fine for a golf cart's worth of buddies; if two people edit
  the same hole in the same second, whichever POST lands last wins. Good enough for this use case.
