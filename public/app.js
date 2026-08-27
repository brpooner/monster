'use strict';
/* ---------- persistent identity ---------- */
const LS = { team: 'wildscan.teamId', name: 'wildscan.teamName' };
let teamId = localStorage.getItem(LS.team);
let teamName = localStorage.getItem(LS.name) || '';

/* ---------- element refs ---------- */
const $ = id => document.getElementById(id);
const gate = $('gate'), startScreen = $('startScreen');

/* ---------- state ---------- */
let here = null, gpsAcc = null, heading = null, tilt = null;
let serverState = null;     // last /api/state response
let active = null;          // creature currently targeted/rendered
let catchRadius = 30;
const NEAR = 8, FOV = 64, UP_MIN = 45, UP_MAX = 135;
let busy = false;

/* ---------- geo math ---------- */
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

/* ---------- team join ---------- */
$('joinBtn').addEventListener('click', async () => {
  const name = $('team').value.trim();
  const pin = $('pin').value.trim();
  $('joinErr').textContent = '';
  if (!name) { $('joinErr').textContent = 'Enter a team name.'; return; }
  try {
    const r = await fetch('/api/team', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin })
    });
    const d = await r.json();
    if (!r.ok) { $('joinErr').textContent = d.error || 'Could not join.'; return; }
    teamId = String(d.teamId); teamName = d.name;
    localStorage.setItem(LS.team, teamId); localStorage.setItem(LS.name, teamName);
    showStart();
  } catch (e) { $('joinErr').textContent = 'Network error — are you online?'; }
});

function showStart() {
  gate.classList.add('hidden');
  startScreen.classList.remove('hidden');
  $('helloTeam').textContent = teamName;
}
$('switchTeam').addEventListener('click', () => {
  localStorage.removeItem(LS.team); localStorage.removeItem(LS.name);
  teamId = null; teamName = '';
  startScreen.classList.add('hidden'); gate.classList.remove('hidden');
  $('team').value = ''; $('pin').value = '';
});

// returning player: skip the name entry
if (teamId && teamName) showStart();

/* ---------- start the hunt ---------- */
$('startBtn').addEventListener('click', async () => {
  $('startErr').textContent = '';
  // camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    $('cam').srcObject = stream;
  } catch (e) { $('startErr').textContent = 'Camera blocked. Allow camera access and try again.'; return; }

  // motion / orientation (iOS asks permission on a tap)
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch (_) {}
  window.addEventListener('deviceorientationabsolute', onOrient, true);
  window.addEventListener('deviceorientation', onOrient, true);

  // gps
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(p => {
      here = { lat: p.coords.latitude, lon: p.coords.longitude };
      gpsAcc = Math.round(p.coords.accuracy);
      $('gps').textContent = '±' + gpsAcc + 'm';
    }, () => { $('gps').textContent = 'off'; }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }

  startScreen.classList.add('hidden');
  ['cam', 'scrim', 'hud'].forEach(id => $(id).classList.remove('hidden'));
  $('teamName').textContent = teamName;

  pollState(); setInterval(pollState, 4000);   // sync with server (others' captures, leaderboard)
  requestAnimationFrame(loop);
});

function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;       // iOS true heading
  else if (typeof e.alpha === 'number') h = (360 - e.alpha) % 360;                  // Android
  if (h != null) { heading = h; $('hd').textContent = Math.round(h) + '°'; }
  if (typeof e.beta === 'number') tilt = e.beta;
}

/* ---------- server sync ---------- */
async function pollState() {
  try {
    const r = await fetch('/api/state?teamId=' + encodeURIComponent(teamId));
    serverState = await r.json();
    catchRadius = serverState.catchRadius || 30;
    if (serverState.team) $('score').textContent = serverState.team.points;
    renderBoardIfOpen(); renderDexIfOpen();
  } catch (_) {}
}

function uncaughtActive() {
  if (!serverState) return [];
  return serverState.monsters.filter(m => !m.captured);
}

/* ---------- main render loop ---------- */
function loop() {
  requestAnimationFrame(loop);
  if (!serverState) { $('target').textContent = 'Connecting…'; return; }
  const remaining = uncaughtActive();

  if (!here) { $('target').textContent = 'Waiting for GPS…'; hideMon(); $('radar').style.display = 'none'; return; }
  if (remaining.length === 0) {
    $('target').innerHTML = 'No creatures in range right now. 🌙';
    hideMon(); $('radar').style.display = 'none'; $('hint').textContent = 'Check the leaderboard, or wait for the next release.';
    return;
  }

  // nearest remaining creature
  let best = null, bd = Infinity;
  for (const m of remaining) { const d = distM(here, m); if (d < bd) { bd = d; best = m; } }
  active = best;
  const brg = bearing(here, best);
  $('target').innerHTML = 'NEAREST: <b>' + best.name + '</b> · ' + Math.round(bd) + 'm · ' + best.points + 'pts';

  const upright = tilt != null && tilt > UP_MIN && tilt < UP_MAX;

  // you're basically on it -> it materializes ahead if the phone is up
  if (bd <= NEAR) {
    if (upright) { showMon(best, 50, 50, bd); $('radar').style.display = 'none'; $('hint').textContent = "It's right here — tap it!"; }
    else { hideMon(); $('hint').textContent = 'Raise your phone to see it'; }
    return;
  }

  if (heading == null) { $('hint').textContent = 'Wave the phone in a figure-8 to wake the compass'; hideMon(); $('radar').style.display='none'; return; }

  const err = angDiff(brg, heading);
  if (upright && Math.abs(err) < FOV / 2) {
    showMon(best, 50 + (err / (FOV / 2)) * 46, 48, bd);
    $('radar').style.display = 'none';
    $('hint').textContent = bd <= catchRadius ? 'Line it up and tap Catch' : 'Get within ' + catchRadius + 'm — move closer';
  } else {
    hideMon();
    $('radar').style.display = 'block';
    $('arrow').setAttribute('transform', 'rotate(' + err + ' 50 50)');
    $('radarLbl').textContent = (err > 0 ? 'turn right ' : 'turn left ') + Math.abs(Math.round(err)) + '° · ' + Math.round(bd) + 'm';
    $('hint').textContent = upright ? 'Sweep toward the arrow' : 'Raise your phone and turn';
  }
}

function showMon(m, xPct, yPct, dist) {
  const el = $('mon');
  el.style.display = 'flex'; el.style.left = xPct + '%'; el.style.top = yPct + '%';
  $('monBody').textContent = m.species || '👾'; $('monTag').textContent = m.name;
  $('catchBtn').style.display = dist <= catchRadius ? 'block' : 'none';
}
function hideMon() { $('mon').style.display = 'none'; $('catchBtn').style.display = 'none'; }

/* ---------- capture ---------- */
async function doCatch() {
  if (!active || busy || !here) return;
  busy = true;
  try {
    const r = await fetch('/api/capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, monsterId: active.id, lat: here.lat, lon: here.lon })
    });
    const d = await r.json();
    if (r.ok) {
      celebrate(d.species, d.name, d.points);
      $('score').textContent = d.teamPoints;
      if (serverState) { const hit = serverState.monsters.find(x => x.id === active.id); if (hit) { hit.captured = true; hit.capturedByYou = true; } }
      hideMon();
      pollState();
    } else if (r.status === 409) {
      $('hint').textContent = 'Too slow — ' + (d.capturedBy || 'another team') + ' already caught it!';
      pollState();
    } else {
      $('hint').textContent = d.error || 'Could not catch that.';
    }
  } catch (_) { $('hint').textContent = 'Network error.'; }
  finally { busy = false; }
}
$('catchBtn').addEventListener('click', doCatch);
$('mon').addEventListener('click', doCatch);

function celebrate(em, name, pts) {
  $('tEm').textContent = em || '✨'; $('tName').textContent = name;
  $('tPts').textContent = '+' + pts + ' pts';
  $('flash').style.opacity = '.85'; setTimeout(() => $('flash').style.opacity = '0', 110);
  const t = $('toast'); t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1500);
}

/* ---------- leaderboard panel ---------- */
$('boardBtn').addEventListener('click', () => { $('board').style.display = 'flex'; renderBoardIfOpen(); });
$('boardClose').addEventListener('click', () => { $('board').style.display = 'none'; });
function renderBoardIfOpen() {
  if ($('board').style.display !== 'flex' || !serverState) return;
  const lb = serverState.leaderboard || [];
  $('boardSub').textContent = lb.length + ' team' + (lb.length === 1 ? '' : 's') + ' · live';
  $('boardList').innerHTML = lb.map((t, i) =>
    `<div class="row ${String(t.id) === String(teamId) ? 'me' : ''}">
      <div class="rank">${i + 1}</div>
      <div class="nm">${esc(t.name)}</div>
      <div class="pts">${t.points}<span class="cnt">${t.catches}🐾</span></div>
    </div>`).join('') || '<div class="sub">No teams yet.</div>';
}

/* ---------- dex panel ---------- */
$('dexBtn').addEventListener('click', () => { $('dex').style.display = 'flex'; renderDexIfOpen(); });
$('dexClose').addEventListener('click', () => { $('dex').style.display = 'none'; });
function renderDexIfOpen() {
  if ($('dex').style.display !== 'flex' || !serverState) return;
  const mine = serverState.monsters.filter(m => m.capturedByYou);
  $('dexSub').textContent = mine.length + ' caught by ' + teamName;
  $('dexList').innerHTML = mine.map(m =>
    `<div class="row dexrow"><div class="em">${m.species || '👾'}</div>
      <div class="nm">${esc(m.name)}<div class="st">+${m.points} pts</div></div></div>`
  ).join('') || '<div class="sub">Nothing yet — go catch something!</div>';
}

function esc(t) { return String(t).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
