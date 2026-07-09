// api/state.js — shared match state for The Hustle, backed by Supabase (one JSON blob per group).
// Every phone GETs to read the live state and POSTs to write it — same contract as
// Mickeltitties' api/state.js, just swapped from Redis to Supabase per request.
//
// Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars.
// Optional: HUSTLE_WRITE_KEY env var to require a write password (must match SYNC_KEY in the app).

import { createClient } from '@supabase/supabase-js';

const WRITE_KEY = process.env.HUSTLE_WRITE_KEY || 'hustle-2026';

let _sb;
function sb() {
  if (!_sb) {
    _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _sb;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'supabase_not_configured' });
    return;
  }

  const groupKey = (req.query && req.query.group) || 'default';

  // ----- READ -----
  if (req.method === 'GET') {
    try {
      const { data, error } = await sb()
        .from('hustle_state')
        .select('payload, updated_at')
        .eq('group_key', groupKey)
        .maybeSingle();
      res.setHeader('Cache-Control', 'no-store');
      if (error) { res.status(502).json({ error: 'read_failed' }); return; }
      if (!data) { res.status(200).json({ empty: true }); return; }
      res.status(200).json(data.payload || { empty: true });
    } catch (e) {
      res.status(502).json({ error: 'read_failed' });
    }
    return;
  }

  // ----- WRITE -----
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (!body || body.key !== WRITE_KEY) { res.status(403).json({ error: 'bad_key' }); return; }
    const payload = body.payload;
    if (!payload || !payload.data) { res.status(400).json({ error: 'bad_payload' }); return; }
    try {
      const { error } = await sb()
        .from('hustle_state')
        .upsert({ group_key: groupKey, payload, updated_at: new Date().toISOString() }, { onConflict: 'group_key' });
      if (error) { res.status(502).json({ error: 'write_failed' }); return; }
      res.status(200).json({ ok: true, t: payload.t });
    } catch (e) {
      res.status(502).json({ error: 'write_failed' });
    }
    return;
  }

  res.status(405).json({ error: 'method' });
}
