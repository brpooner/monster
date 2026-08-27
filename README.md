# Wildscan — Monster Hunt

GPS + camera-AR creature hunt for a private property. Teams, per-creature points,
time-windowed monsters, server-refereed "first team wins" captures, and a live leaderboard.

- **Players:** `https://game.qrcritter.com`
- **You (admin):** `https://game.qrcritter.com/admin`

## How it plays
Each phone picks a team name (same name = one shared score; optional 4-digit PIN).
Raise the phone like a window and sweep — a creature appears when you face its GPS spot.
Get within the catch radius (default 30 m) and tap to catch. The server checks distance
and the active time window, and locks each creature to the first team that reaches it.

## Stack
- Node + Express, SQLite (`better-sqlite3`). Binds `127.0.0.1:3000` behind Caddy.
- No build step. State lives in `data/monster-hunt.db` (gitignored).

## First-time setup on the server
1. `.env` (never committed) holds the admin secret:
   ```
   cp .env.example .env
   nano .env         # set ADMIN_KEY to something long and random
   ```
2. `npm install`
3. systemd unit: see `deploy/monster-hunt.service`
4. Caddy block: see `deploy/Caddyfile.snippet`

## Updating (every change after that)
On your laptop: commit + push in GitHub Desktop. Then on the server:
```
cd /opt/monster-hunt
git pull
npm install            # only needed when dependencies change
sudo systemctl restart monster-hunt
```

## Loading a day's monsters
1. In Google Earth, drop a placemark per creature, name each one, export the folder as **KML**.
2. Go to `/admin`, enter your admin key.
3. Paste the KML (or a JSON list of `{name, lat, lon}`), set default emoji/points and the
   active start/end times (entered in your local time), then **Parse & preview**.
4. Tweak names/points per row, then **Add** (append) or **Replace ALL**.
5. Between two days on the same monster set, use **Reset captures** to zero the scores.

## Admin API (all require header `x-admin-key`)
- `POST /api/admin/parse-kml` `{kml}` → preview points
- `POST /api/admin/import` `{monsters:[…], mode:'append'|'replace'}`
- `GET  /api/admin/dump` → monsters + leaderboard
- `POST /api/admin/reset` `{what:'captures'|'all'}`
