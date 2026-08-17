const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'monster-hunt.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS monsters (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    captured_by TEXT,
    captured_at TEXT
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isCoordinate(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const radius = 6_371_000;
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(bLat - aLat);
  const dLng = radians(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

app.get('/api/monsters', (_request, response) => {
  const monsters = db.prepare(`
    SELECT id, name, latitude, longitude, captured_by AS capturedBy, captured_at AS capturedAt
    FROM monsters ORDER BY id DESC
  `).all();
  response.json(monsters);
});

// Temporary demo action. This becomes the protected admin placement endpoint next.
app.post('/api/demo-monster', (request, response) => {
  const { latitude, longitude } = request.body;
  if (!isCoordinate(latitude, -90, 90) || !isCoordinate(longitude, -180, 180)) {
    return response.status(400).json({ error: 'A valid location is required.' });
  }
  db.prepare('DELETE FROM monsters WHERE name = ?').run('Demo Wisp');
  const result = db.prepare(`
    INSERT INTO monsters (name, latitude, longitude) VALUES (?, ?, ?)
  `).run('Demo Wisp', latitude + 0.00018, longitude + 0.00018);
  response.status(201).json({ id: result.lastInsertRowid, message: 'Demo Wisp placed nearby.' });
});

app.post('/api/monsters/:id/capture', (request, response) => {
  const id = Number(request.params.id);
  const { latitude, longitude, playerName = 'Guest hunter' } = request.body;
  if (!Number.isInteger(id) || !isCoordinate(latitude, -90, 90) || !isCoordinate(longitude, -180, 180)) {
    return response.status(400).json({ error: 'A valid monster and location are required.' });
  }
  const monster = db.prepare('SELECT * FROM monsters WHERE id = ?').get(id);
  if (!monster) return response.status(404).json({ error: 'Monster not found.' });
  if (monster.captured_by) return response.status(409).json({ error: 'That monster was already captured.' });
  const metersAway = distanceMeters(latitude, longitude, monster.latitude, monster.longitude);
  if (metersAway > 35) {
    return response.status(403).json({ error: `Get closer — you are ${Math.round(metersAway)} m away.` });
  }
  db.prepare('UPDATE monsters SET captured_by = ?, captured_at = ? WHERE id = ?')
    .run(String(playerName).slice(0, 40), new Date().toISOString(), id);
  response.json({ message: `Captured ${monster.name}!`, metersAway: Math.round(metersAway) });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Monster Hunt is running on http://127.0.0.1:${port}`);
});
