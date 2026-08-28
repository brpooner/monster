'use strict';
const $ = id => document.getElementById(id);
let parsed = [];   // preview rows

function key() { return $('key').value.trim(); }
function headers() { return { 'Content-Type': 'application/json', 'x-admin-key': key() }; }
function localToMs(v) { return v ? new Date(v).getTime() : null; }  // datetime-local is in the admin's local tz

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

/* ---------- parse & preview ---------- */
$('parseBtn').addEventListener('click', async () => {
  const src = $('src').value.trim();
  $('parseMsg').className = 'msg'; $('parseMsg').textContent = '';
  if (!src) { $('parseMsg').textContent = 'Paste some KML or JSON first.'; return; }

  try {
    let points = [];
    if (src.startsWith('[') || src.startsWith('{')) {
      const j = JSON.parse(src);
      const arr = Array.isArray(j) ? j : [j];
      points = arr.map(o => ({ name: o.name || '', lat: +o.lat, lon: +o.lon }))
                  .filter(o => Number.isFinite(o.lat) && Number.isFinite(o.lon));
    } else {
      const d = await api('/api/admin/parse-kml', { kml: src });   // server-side KML parse (also checks admin key)
      points = d.points;
    }
    if (!points.length) { $('parseMsg').className = 'msg bad'; $('parseMsg').textContent = 'No point placemarks found.'; return; }

    const species = $('species').value || '👾';
    const pts = parseInt($('points').value, 10) || 0;
    parsed = points.map((p, i) => ({
      name: p.name || ('Monster ' + (i + 1)), species, points: pts, lat: p.lat, lon: p.lon
    }));
    renderPreview();
    $('parseMsg').className = 'msg ok';
    $('parseMsg').textContent = 'Parsed ' + parsed.length + ' monster(s). Edit below, then import.';
  } catch (e) {
    $('parseMsg').className = 'msg bad'; $('parseMsg').textContent = e.message;
  }
});

function renderPreview() {
  if (typeof syncPins === 'function') syncPins();
  $('prevTable').style.display = ''; $('importBtns').style.display = 'flex';
  $('prevBody').innerHTML = parsed.map((m, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><input data-i="${i}" data-f="name" value="${esc(m.name)}"></td>
      <td><input data-i="${i}" data-f="species" value="${esc(m.species)}" style="width:64px"></td>
      <td><input data-i="${i}" data-f="points" type="number" value="${m.points}" style="width:74px"></td>
      <td>${m.lat.toFixed(6)}</td><td>${m.lon.toFixed(6)}</td>
    </tr>`).join('');
  $('prevBody').querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = +inp.dataset.i, f = inp.dataset.f;
      parsed[i][f] = f === 'points' ? (parseInt(inp.value, 10) || 0) : inp.value;
    });
  });
}

/* ---------- import ---------- */
async function doImport(mode) {
  $('importMsg').className = 'msg'; $('importMsg').textContent = 'Importing…';
  const start_ms = localToMs($('start').value), end_ms = localToMs($('end').value);
  const monsters = parsed.map(m => ({ ...m, start_ms, end_ms }));
  try {
    const d = await api('/api/admin/import', { monsters, mode });
    $('importMsg').className = 'msg ok';
    $('importMsg').textContent = `Imported ${d.added}. Total now ${d.total}.`;
    loadState();
  } catch (e) { $('importMsg').className = 'msg bad'; $('importMsg').textContent = e.message; }
}
$('appendBtn').addEventListener('click', () => doImport('append'));
$('replaceBtn').addEventListener('click', () => { if (confirm('Replace ALL monsters and clear captures?')) doImport('replace'); });

/* ---------- current state ---------- */
$('loadBtn').addEventListener('click', loadState);
async function loadState() {
  $('keyMsg').className = 'msg'; $('keyMsg').textContent = 'Loading…';
  try {
    const r = await fetch('/api/admin/dump', { headers: { 'x-admin-key': key() } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    $('keyMsg').className = 'msg ok'; $('keyMsg').textContent = 'Key OK.';
    const rows = d.monsters || [];
    $('countMsg').textContent = rows.length + ' monster(s). ' + (d.leaderboard || []).length + ' team(s).';
    $('curTable').style.display = rows.length ? '' : 'none';
    $('curBody').innerHTML = rows.map(m => `
      <tr>
        <td>${m.id}</td><td>${esc(m.name)}</td><td>${esc(m.species)}</td><td>${m.points}</td>
        <td><span class="pill ${m.active ? 'on' : 'off'}">${m.active ? 'active' : 'inactive'}</span></td>
        <td>${m.capturedBy ? esc(m.capturedBy) : '—'}</td>
      </tr>`).join('');
  } catch (e) { $('keyMsg').className = 'msg bad'; $('keyMsg').textContent = e.message; }
}

/* ---------- reset ---------- */
$('resetCaps').addEventListener('click', async () => {
  if (!confirm('Clear all captures/scores? Monsters stay.')) return;
  try { await api('/api/admin/reset', { what: 'captures' }); $('resetMsg').className = 'msg ok'; $('resetMsg').textContent = 'Captures cleared.'; loadState(); }
  catch (e) { $('resetMsg').className = 'msg bad'; $('resetMsg').textContent = e.message; }
});
$('resetAll').addEventListener('click', async () => {
  if (!confirm('Wipe ALL monsters and captures?')) return;
  try { await api('/api/admin/reset', { what: 'all' }); $('resetMsg').className = 'msg ok'; $('resetMsg').textContent = 'Everything wiped.'; loadState(); }
  catch (e) { $('resetMsg').className = 'msg bad'; $('resetMsg').textContent = e.message; }
});


/* ---------- placement map (satellite/streets, tap to drop) ---------- */
let amap, pins, satLayer, streetLayer;
function initAdminMap() {
  satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, attribution: 'Imagery © Esri' });
  streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap' });
  amap = L.map('amap', { zoomControl: true }).setView([41.111966, -83.213732], 16);
  satLayer.addTo(amap);
  pins = L.layerGroup().addTo(amap);
  amap.on('click', onMapClick);
  setTimeout(() => amap.invalidateSize(), 200);
}
$('satBtn').addEventListener('click', () => { amap.removeLayer(streetLayer); satLayer.addTo(amap); });
$('streetBtn').addEventListener('click', () => { amap.removeLayer(satLayer); streetLayer.addTo(amap); });
$('findMe').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p => amap.setView([p.coords.latitude, p.coords.longitude], 18),
    () => alert('Could not get your location.'), { enableHighAccuracy: true });
});
$('clearPlaced').addEventListener('click', () => { parsed = []; syncPins(); renderPreview(); });

function randomFromPool() {
  try {
    const pool = JSON.parse($('pool').value);
    if (Array.isArray(pool) && pool.length) {
      const p = pool[Math.floor(Math.random() * pool.length)];
      return { name: p.name || 'Monster', species: p.emoji || p.species || '👾', points: +p.points || 10 };
    }
  } catch (_) {}
  return null;
}
function onMapClick(e) {
  const lat = +e.latlng.lat.toFixed(6), lon = +e.latlng.lng.toFixed(6);
  let m;
  if ($('rndOn').checked) {
    m = randomFromPool() || { name: 'Monster', species: $('species').value || '👾', points: parseInt($('points').value, 10) || 10 };
  } else {
    const nm = prompt('Monster name for this spot?', 'Monster ' + (parsed.length + 1));
    if (nm === null) return;
    m = { name: nm || ('Monster ' + (parsed.length + 1)), species: $('species').value || '👾', points: parseInt($('points').value, 10) || 10 };
  }
  parsed.push({ ...m, lat, lon });
  syncPins(); renderPreview();
}
// redraw all pins from the current parsed[] so map + preview always match
function syncPins() {
  if (!pins) return;
  pins.clearLayers();
  parsed.forEach((m, i) => {
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) return;
    const mk = L.marker([m.lat, m.lon], {
      icon: L.divIcon({ className: '', html: `<div class="mon-pin">${esc(m.species || '👾')}</div>`, iconSize: [30,30], iconAnchor: [15,15] })
    }).bindTooltip(`${esc(m.name)} · ${m.points}pts (tap to remove)`);
    mk.on('click', () => { parsed.splice(i, 1); syncPins(); renderPreview(); });
    pins.addLayer(mk);
  });
}
window.addEventListener('load', initAdminMap);

function esc(t) { return String(t).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
