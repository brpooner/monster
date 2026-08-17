# Monster Hunt prototype

A deliberately small first build: a Leaflet/OpenStreetMap map, browser GPS, a temporary nearby demo monster, and a server-side proximity check before capture. Game state is stored in SQLite at `data/monster-hunt.db`.

## Run locally

1. Install a current Node.js LTS release.
2. From this folder, run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

For real phone GPS testing, the eventual `https://game.qrcritter.com` Caddy subdomain is important: browsers require a secure context for location on non-local addresses. No server configuration is included or changed in this prototype.

## Intended next steps

1. Add a password-protected admin placement page; remove the public demo-placement action.
2. Add player records, capture points, and a leaderboard.
3. Choose a commercial satellite-map provider (likely Mapbox) and configure its key through an environment variable.
4. Add AR after the GPS hunt loop is proven enjoyable.
