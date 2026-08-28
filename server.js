'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const store = require('./db');
const { parseKml } = require('./kml');

/* ---------- tiny .env loader (no dependency) ---------- */
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) {}
})();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const YARDS_PER_M = 1.0936133;
const CATCH_RADIUS_YD = Number(process.env.CATCH_RADIUS_YD || 30); // server-authoritative
const CATCH_RADIUS_M = CATCH_RADIUS_YD / YARDS_PER_M;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */
function distanceM(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function isActive(m, now) {
  return (m.start_ms == null || now >= m.start_ms) &&
         (m.end_ms == null || now <= m.end_ms);
}
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin key not configured on server (.env ADMIN_KEY).' });
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'Bad admin key.' });
  next();
}

/* ---------- teams ---------- */
// Create or join a team. Same name = same team (shared score).
// If the team exists and has a PIN, the caller must supply the matching PIN.
app.post('/api/team', (req, res) => {
  let { name, pin } = req.body || {};
  name = (name || '').trim();
  pin = (pin || '').trim();
  if (name.length < 1 || name.length > 40) return res.status(400).json({ error: 'Team name must be 1–40 characters.' });
  if (pin && !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits (or blank).' });

  let team = store.teamByName.get(name);
  if (team) {
    if (team.pin && team.pin !== pin) return res.status(403).json({ error: 'Wrong PIN for that team name.' });
    return res.json({ teamId: team.id, name: team.name, joined: true });
  }
  const info = store.createTeam.run({ name, pin: pin || null, created_at: Date.now() });
  res.json({ teamId: info.lastInsertRowid, name, joined: false });
});

/* ---------- game state ---------- */
// Everything a phone needs: active monsters (with capture status), your totals, leaderboard.
app.get('/api/state', (req, res) => {
  const teamId = Number(req.query.teamId) || null;
  const now = Date.now();
  const rows = store.monstersWithStatus.all();

  const monsters = rows
    .filter(m => isActive(m, now) || m.captured_team_id) // show active, plus recently-captured so it can vanish client-side
    .map(m => ({
      id: m.id, name: m.name, species: m.species,
      lat: m.lat, lon: m.lon, points: m.points,
      end_ms: m.end_ms,
      captured: m.captured_team_id != null,
      capturedByYou: teamId != null && m.captured_team_id === teamId,
      capturedBy: m.captured_team_name || null
    }));

  const leaderboard = store.leaderboard.all();
  const me = teamId ? store.teamById.get(teamId) : null;
  const myRow = leaderboard.find(r => r.id === teamId) || null;

  res.json({
    now,
    catchRadiusYd: CATCH_RADIUS_YD,
    catchRadiusM: CATCH_RADIUS_M,
    team: me ? { id: me.id, name: me.name, points: myRow ? myRow.points : 0, catches: myRow ? myRow.catches : 0 } : null,
    monsters,
    leaderboard
  });
});

/* ---------- capture (server is the referee) ---------- */
app.post('/api/capture', (req, res) => {
  const { teamId, monsterId, lat, lon } = req.body || {};
  const team = teamId ? store.teamById.get(Number(teamId)) : null;
  if (!team) return res.status(400).json({ error: 'Join a team first.' });

  const m = store.allMonsters.all().find(x => x.id === Number(monsterId));
  if (!m) return res.status(404).json({ error: 'No such monster.' });

  const now = Date.now();
  if (!isActive(m, now)) return res.status(410).json({ error: 'That monster is not active right now.' });

  // proximity check (only if the phone sent coordinates)
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const d = distanceM(lat, lon, m.lat, m.lon);
    if (d > CATCH_RADIUS_M) {
      const yd = Math.round(d * YARDS_PER_M);
      return res.status(422).json({ error: `Too far (${yd} yds). Get within ${CATCH_RADIUS_YD} yds.`, distanceYd: yd });
    }
  } else {
    return res.status(400).json({ error: 'Missing your location.' });
  }

  // first-team-wins: the PRIMARY KEY on captures.monster_id makes this atomic.
  try {
    store.insertCapture.run({
      monster_id: m.id, team_id: team.id, captured_at: now,
      lat: Number(lat), lon: Number(lon)
    });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
      const existing = store.captureByMonster.get(m.id);
      const byTeam = existing ? store.teamById.get(existing.team_id) : null;
      return res.status(409).json({ error: 'Already captured.', capturedBy: byTeam ? byTeam.name : 'another team' });
    }
    throw e;
  }

  const myRow = store.leaderboard.all().find(r => r.id === team.id);
  res.json({ ok: true, name: m.name, species: m.species, points: m.points,
             teamPoints: myRow ? myRow.points : m.points });
});

/* ---------- admin ---------- */
app.get('/api/admin/dump', requireAdmin, (req, res) => {
  const now = Date.now();
  const rows = store.monstersWithStatus.all().map(m => ({
    id: m.id, name: m.name, species: m.species, lat: m.lat, lon: m.lon,
    points: m.points, start_ms: m.start_ms, end_ms: m.end_ms,
    active: isActive(m, now),
    capturedBy: m.captured_team_name || null
  }));
  res.json({ monsters: rows, leaderboard: store.leaderboard.all() });
});

// Import monsters. body: { monsters:[{name,species?,lat,lon,points?,start_ms?,end_ms?}], mode:'append'|'replace' }
app.post('/api/admin/import', requireAdmin, (req, res) => {
  const { monsters, mode } = req.body || {};
  if (!Array.isArray(monsters) || monsters.length === 0) return res.status(400).json({ error: 'No monsters provided.' });

  const now = Date.now();
  const insertMany = store.db.transaction((list) => {
    if (mode === 'replace') { store.clearCaptures.run(); store.clearMonsters.run(); }
    let n = 0;
    for (const m of list) {
      const lat = parseFloat(m.lat), lon = parseFloat(m.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      store.insertMonster.run({
        name: (m.name || 'Monster').toString().slice(0, 60),
        species: (m.species || '👾').toString().slice(0, 8),
        lat, lon,
        points: Number.isFinite(+m.points) ? Math.round(+m.points) : 10,
        start_ms: m.start_ms != null ? Math.round(+m.start_ms) : null,
        end_ms: m.end_ms != null ? Math.round(+m.end_ms) : null,
        created_at: now
      });
      n++;
    }
    return n;
  });

  const added = insertMany(monsters);
  res.json({ ok: true, added, total: store.allMonsters.all().length });
});

// Parse a KML string into monster rows (does NOT save; admin reviews then imports).
app.post('/api/admin/parse-kml', requireAdmin, (req, res) => {
  const { kml } = req.body || {};
  const points = parseKml(kml);
  res.json({ ok: true, count: points.length, points });
});

// Reset. body: { what: 'captures' | 'all' }
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const what = (req.body && req.body.what) || '';
  if (what === 'captures') { store.clearCaptures.run(); return res.json({ ok: true, reset: 'captures' }); }
  if (what === 'all') { store.clearCaptures.run(); store.clearMonsters.run(); return res.json({ ok: true, reset: 'all' }); }
  res.status(400).json({ error: "Specify what: 'captures' or 'all'." });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, HOST, () => {
  console.log(`Monster Hunt listening on http://${HOST}:${PORT}`);
  if (!ADMIN_KEY) console.log('WARNING: no ADMIN_KEY set — admin endpoints are disabled until you create .env');
});
