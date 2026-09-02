'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'monster-hunt.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  pin        TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monsters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  species    TEXT NOT NULL DEFAULT '👾',
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  points     INTEGER NOT NULL DEFAULT 10,
  start_ms   INTEGER,            -- null = active from the beginning of time
  end_ms     INTEGER,            -- null = never expires
  created_at INTEGER NOT NULL
);

-- monster_id is the PRIMARY KEY, so a monster can be captured exactly once.
-- That single constraint is what enforces "first team wins".
CREATE TABLE IF NOT EXISTS captures (
  monster_id  INTEGER PRIMARY KEY REFERENCES monsters(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  lat         REAL,
  lon         REAL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

module.exports = {
  db,

  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (@key, @value)
                          ON CONFLICT(key) DO UPDATE SET value = @value`),


  createTeam: db.prepare(
    `INSERT INTO teams (name, pin, created_at) VALUES (@name, @pin, @created_at)`
  ),
  teamByName: db.prepare(`SELECT * FROM teams WHERE name = ? COLLATE NOCASE`),
  teamById: db.prepare(`SELECT * FROM teams WHERE id = ?`),

  insertMonster: db.prepare(
    `INSERT INTO monsters (name, species, lat, lon, points, start_ms, end_ms, created_at)
     VALUES (@name, @species, @lat, @lon, @points, @start_ms, @end_ms, @created_at)`
  ),
  allMonsters: db.prepare(`SELECT * FROM monsters ORDER BY id`),
  clearMonsters: db.prepare(`DELETE FROM monsters`),
  clearCaptures: db.prepare(`DELETE FROM captures`),

  insertCapture: db.prepare(
    `INSERT INTO captures (monster_id, team_id, captured_at, lat, lon)
     VALUES (@monster_id, @team_id, @captured_at, @lat, @lon)`
  ),
  captureByMonster: db.prepare(`SELECT * FROM captures WHERE monster_id = ?`),

  // monsters joined with their capture (if any) + capturing team name
  monstersWithStatus: db.prepare(`
    SELECT m.*, c.team_id AS captured_team_id, c.captured_at,
           t.name AS captured_team_name
    FROM monsters m
    LEFT JOIN captures c ON c.monster_id = m.id
    LEFT JOIN teams t    ON t.id = c.team_id
    ORDER BY m.id
  `),

  leaderboard: db.prepare(`
    SELECT t.id, t.name,
           COALESCE(SUM(m.points), 0) AS points,
           COUNT(c.monster_id)        AS catches
    FROM teams t
    LEFT JOIN captures c ON c.team_id = t.id
    LEFT JOIN monsters m ON m.id = c.monster_id
    GROUP BY t.id
    ORDER BY points DESC, catches DESC, t.name ASC
  `)
};
