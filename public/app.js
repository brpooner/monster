'use strict';
/* ---------- identity ---------- */
const LS = { team: 'wildscan.teamId', name: 'wildscan.teamName' };
let teamId = localStorage.getItem(LS.team);
let teamName = localStorage.getItem(LS.name) || '';
const $ = id => document.getElementById(id);

/* ---------- state ---------- */
const YPM = 1.0936133;
let here = null, gpsAcc = null, heading = null, headingAcc = null;
let serverState = null, active = null;
let catchRadiusM = 27.43, catchRadiusYd = 30;
let mode = 'compass';          // actual visible mode: compass | map | capture | rest
let userView = 'compass';      // what the player chose while hunting: compass | map
let camStream = null, busy = false, capturing = false;
let map = null, meMarker = null, meRing = null, monMarkers = {}, followMe = true;

/* ---------- geo ---------- */
const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
function distM(a, b) {
  const R = 6371000, dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const y = Math.sin(toRad(b.lon-a.lon))*Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat))*Math.sin(toRad(b.lat)) -
            Math.sin(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.cos(toRad(b.lon-a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
const yards = m => Math.round(m * YPM);

/* ---------- team join ---------- */
$('joinBtn').addEventListener('click', async () => {
  const name = $('team').value.trim(), pin = $('pin').value.trim();
  $('joinErr').textContent = '';
  if (!name) { $('joinErr').textContent = 'Enter a team name.'; return; }
  try {
    const r = await fetch('/api/team', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, pin }) });
    const d = await r.json();
    if (!r.ok) { $('joinErr').textContent = d.error || 'Could not join.'; return; }
    teamId = String(d.teamId); teamName = d.name;
    localStorage.setItem(LS.team, teamId); localStorage.setItem(LS.name, teamName);
    showStart();
  } catch (e) { $('joinErr').textContent = 'Network error — are you online?'; }
});
function showStart(){ $('gate').classList.add('hidden'); $('startScreen').classList.remove('hidden'); $('helloTeam').textContent = teamName; }
$('switchTeam').addEventListener('click', () => {
  localStorage.removeItem(LS.team); localStorage.removeItem(LS.name); teamId=null; teamName='';
  $('startScreen').classList.add('hidden'); $('gate').classList.remove('hidden'); $('team').value=''; $('pin').value='';
});
if (teamId && teamName) showStart();

/* ---------- start hunt ---------- */
$('startBtn').addEventListener('click', async () => {
  $('startErr').textContent = '';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false });
    s.getTracks().forEach(t => t.stop());
  } catch (e) { $('startErr').textContent = 'Camera blocked. Allow camera access and try again.'; return; }
  try { if (DeviceOrientationEvent?.requestPermission) await DeviceOrientationEvent.requestPermission(); } catch(_){}
  window.addEventListener('deviceorientationabsolute', onOrient, true);
  window.addEventListener('deviceorientation', onOrient, true);

  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(p => {
      here = { lat:p.coords.latitude, lon:p.coords.longitude }; gpsAcc = Math.round(p.coords.accuracy);
      $('gps').textContent = '±' + gpsAcc + 'm'; updateMeOnMap();
    }, () => { $('gps').textContent = 'off'; }, { enableHighAccuracy:true, maximumAge:1000, timeout:20000 });
  }

  $('startScreen').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('teamName').textContent = teamName;
  initMap();
  applyMode('compass');
  pollState(); setInterval(pollState, 4000);
  requestAnimationFrame(loop);
});

function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') { h = e.webkitCompassHeading; headingAcc = e.webkitCompassAccuracy; }
  else if (typeof e.alpha === 'number') { h = (360 - e.alpha) % 360; }
  if (h != null) heading = h;
}

/* ---------- camera ---------- */
async function startCamera() {
  if (camStream) return;
  try { camStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false }); $('cam').srcObject = camStream; } catch(_){}
}
function stopCamera() { if (camStream){ camStream.getTracks().forEach(t=>t.stop()); camStream=null; $('cam').srcObject=null; } }

/* ---------- map ---------- */
function initMap() {
  map = L.map('map', { zoomControl:false, attributionControl:false }).setView([41.111966,-83.213732], 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
  map.on('dragstart', () => { followMe = false; });
}
function updateMeOnMap() {
  if (!map || !here) return;
  const ll = [here.lat, here.lon];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className:'', html:'<div class="me-dot"></div>', iconSize:[18,18], iconAnchor:[9,9] }) }).addTo(map);
    meRing = L.circle(ll, { radius: catchRadiusM, color:'#7dff9b', weight:1, fillColor:'#7dff9b', fillOpacity:.08 }).addTo(map);
  } else { meMarker.setLatLng(ll); meRing.setLatLng(ll); }
  if (followMe && mode === 'map') map.setView(ll, map.getZoom(), { animate:true });
}
function refreshMonMarkers() {
  if (!map || !serverState) return;
  const live = {};
  for (const m of serverState.monsters) {
    if (m.captured) continue;
    live[m.id] = true;
    if (monMarkers[m.id]) monMarkers[m.id].setLatLng([m.lat, m.lon]);
    else monMarkers[m.id] = L.marker([m.lat, m.lon], {
      icon: L.divIcon({ className:'', html:`<div class="mon-pin">${m.species||'👾'}</div>`, iconSize:[34,34], iconAnchor:[17,17] })
    }).addTo(map).bindPopup(`${esc(m.name)} · ${m.points} pts`);
  }
  for (const id in monMarkers) if (!live[id]) { map.removeLayer(monMarkers[id]); delete monMarkers[id]; }
}

/* ---------- mode application ---------- */
function applyMode(m) {
  if (m === mode) return;
  mode = m;
  const isMap = m==='map', isCx = m==='compass', isCap = m==='capture', isRest = m==='rest';
  $('compass').classList.toggle('hidden', !isCx);
  $('map').classList.toggle('hidden', !isMap);
  $('rest').classList.toggle('hidden', !isRest);
  $('cam').classList.toggle('hidden', !isCap);
  $('scrim').classList.toggle('hidden', !isCap);
  $('capHud').classList.toggle('hidden', !isCap);
  // mode toggle only makes sense while actively hunting (compass/map)
  $('modeBtn').style.display = (isCap || isRest) ? 'none' : 'block';
  $('modeBtn').textContent = isMap ? '‹ Compass' : 'Map ›';
  if (isMap) { followMe = true; setTimeout(() => map && map.invalidateSize(), 60); updateMeOnMap(); refreshMonMarkers(); }
  if (isCap) { startCamera(); } else { stopCamera(); hideMon(); }
  if (isRest) renderRest();
}
$('modeBtn').addEventListener('click', () => {
  if (mode === 'capture' || mode === 'rest') return;
  userView = (mode === 'compass') ? 'map' : 'compass';
  applyMode(userView);
});

/* ---------- server sync ---------- */
async function pollState() {
  try {
    const r = await fetch('/api/state?teamId=' + encodeURIComponent(teamId));
    serverState = await r.json();
    catchRadiusYd = serverState.catchRadiusYd || 30;
    catchRadiusM  = serverState.catchRadiusM || (catchRadiusYd / YPM);
    if (meRing) meRing.setRadius(catchRadiusM);
    if (serverState.team) $('score').textContent = serverState.team.points;
    refreshMonMarkers(); renderBoardIfOpen(); renderDexIfOpen(); if (mode==='rest') renderRest();
  } catch (_) {}
}
function uncaught() { return serverState ? serverState.monsters.filter(m => !m.captured) : []; }

/* ---------- main loop ---------- */
function loop() {
  requestAnimationFrame(loop);
  if (!serverState) { $('near').textContent = '…'; return; }
  const rem = uncaught();

  // Case 2: nothing active -> standings
  if (rem.length === 0) { $('near').textContent = 'none'; capturing = false; applyMode('rest'); return; }

  if (!here) { $('near').textContent = 'GPS…'; if (mode==='capture'){ capturing=false; applyMode(userView);} if (mode==='rest') applyMode(userView); return; }

  // nearest creature
  let best = null, bd = Infinity;
  for (const m of rem) { const d = distM(here, m); if (d < bd) { bd = d; best = m; } }
  active = best;
  const brg = bearing(here, best);
  $('near').textContent = best.name + ' · ' + yards(bd) + 'yd';

  // capture with hysteresis to avoid boundary flicker
  if (!capturing && bd <= catchRadiusM) capturing = true;
  else if (capturing && bd > catchRadiusM * 1.25) capturing = false;

  if (capturing) { if (mode !== 'capture') applyMode('capture'); renderCapture(best); }
  else {
    if (mode === 'capture' || mode === 'rest') applyMode(userView);
    if (mode === 'compass') renderCompass(best, brg, bd);
  }
}

/* ---------- compass ---------- */
function renderCompass(m, brg, d) {
  $('cxName').innerHTML = 'Nearest: <b>' + esc(m.name) + '</b> · ' + m.points + ' pts';
  $('cxDist').textContent = yards(d) + ' yds';
  const bad = heading == null || (typeof headingAcc === 'number' && (headingAcc < 0 || headingAcc > 20));
  $('cxCal').classList.toggle('hidden', !bad);
  if (heading != null) $('cxArrow').style.transform = 'rotate(' + angDiff(brg, heading) + 'deg)';
}

/* ---------- capture (camera, monster centered, no aim gating) ---------- */
function renderCapture(m) {
  const el = $('mon');
  if (el.style.display !== 'flex') {
    el.style.display='flex'; el.style.left='50%'; el.style.top='48%';
    $('monBody').textContent = m.species || '👾'; $('monTag').textContent = m.name;
    $('catchBtn').style.display='block';
  }
  $('capHint').textContent = 'Tap the creature to catch — ' + m.points + ' pts';
}
function hideMon(){ $('mon').style.display='none'; $('catchBtn').style.display='none'; }

async function doCatch() {
  if (!active || busy || !here) return;
  busy = true;
  try {
    const r = await fetch('/api/capture', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ teamId, monsterId: active.id, lat: here.lat, lon: here.lon }) });
    const d = await r.json();
    if (r.ok) {
      celebrate(d.species, d.name, d.points); $('score').textContent = d.teamPoints;
      const hit = serverState.monsters.find(x => x.id === active.id); if (hit){ hit.captured=true; hit.capturedByYou=true; }
      if (monMarkers[active.id]) { map.removeLayer(monMarkers[active.id]); delete monMarkers[active.id]; }
      capturing = false; hideMon(); applyMode(userView); pollState();
    } else if (r.status === 409) { $('capHint').textContent = 'Too slow — ' + (d.capturedBy||'another team') + ' got it!'; capturing=false; pollState(); }
    else { $('capHint').textContent = d.error || 'Could not catch that.'; }
  } catch (_) { $('capHint').textContent = 'Network error.'; }
  finally { busy = false; }
}
$('catchBtn').addEventListener('click', doCatch);
$('mon').addEventListener('click', doCatch);
function celebrate(em, name, pts) {
  $('tEm').textContent = em || '✨'; $('tName').textContent = name; $('tPts').textContent = '+' + pts + ' pts';
  $('flash').style.opacity='.85'; setTimeout(()=>$('flash').style.opacity='0',110);
  const t = $('toast'); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1500);
}

/* ---------- standings / panels ---------- */
function standingsHTML() {
  const lb = (serverState && serverState.leaderboard) || [];
  return lb.map((t,i) =>
    `<div class="row ${String(t.id)===String(teamId)?'me':''}"><div class="rank">${i+1}</div>
     <div class="nm">${esc(t.name)}</div><div class="pts">${t.points}<span class="cnt">${t.catches}🐾</span></div></div>`
  ).join('') || '<div class="sub">No teams yet.</div>';
}
function renderRest() {
  const anyMonsters = serverState && serverState.monsters.length > 0;
  $('restTitle').textContent = anyMonsters ? 'All creatures caught! 🎉' : 'No creatures active right now';
  $('restList').innerHTML = standingsHTML();
}
$('boardBtn').addEventListener('click', () => { $('board').style.display='flex'; renderBoardIfOpen(); });
$('boardClose').addEventListener('click', () => { $('board').style.display='none'; });
function renderBoardIfOpen() {
  if ($('board').style.display !== 'flex' || !serverState) return;
  const lb = serverState.leaderboard || [];
  $('boardSub').textContent = lb.length + ' team' + (lb.length===1?'':'s') + ' · live';
  $('boardList').innerHTML = standingsHTML();
}
$('dexBtn').addEventListener('click', () => { $('dex').style.display='flex'; renderDexIfOpen(); });
$('dexClose').addEventListener('click', () => { $('dex').style.display='none'; });
function renderDexIfOpen() {
  if ($('dex').style.display !== 'flex' || !serverState) return;
  const mine = serverState.monsters.filter(m => m.capturedByYou);
  $('dexSub').textContent = mine.length + ' caught by ' + teamName;
  $('dexList').innerHTML = mine.map(m =>
    `<div class="row dexrow"><div class="em">${m.species||'👾'}</div><div class="nm">${esc(m.name)}<div class="st">+${m.points} pts</div></div></div>`
  ).join('') || '<div class="sub">Nothing yet — go catch something!</div>';
}

function esc(t){ return String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
