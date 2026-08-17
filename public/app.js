const map = L.map('map').setView([39.5, -98.35], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const status = document.querySelector('#status');
const placeButton = document.querySelector('#place-demo');
let playerLocation;
let playerMarker;
let monsterMarkers = [];

function setStatus(message) { status.textContent = message; }
function hunterName() { return document.querySelector('#player-name').value.trim() || 'Guest hunter'; }

async function loadMonsters() {
  const monsters = await fetch('/api/monsters').then(r => r.json());
  monsterMarkers.forEach(marker => marker.remove());
  monsterMarkers = monsters.map(monster => {
    const marker = L.marker([monster.latitude, monster.longitude], { title: monster.name, icon: L.divIcon({ className: 'monster-marker', html: '👾', iconSize: [38, 38], iconAnchor: [19, 19] }) }).addTo(map);
    const state = monster.capturedBy ? `Captured by ${monster.capturedBy}` : '<button class="capture">Capture</button>';
    marker.bindPopup(`<strong>👾 ${monster.name}</strong><br>${state}`);
    marker.on('popupopen', () => {
      const button = document.querySelector('.capture');
      if (button) button.onclick = () => capture(monster.id);
    });
    return marker;
  });
}

function locate() {
  if (!navigator.geolocation) return setStatus('This browser does not support GPS location.');
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    playerLocation = { latitude: coords.latitude, longitude: coords.longitude };
    const point = [coords.latitude, coords.longitude];
    if (playerMarker) playerMarker.setLatLng(point); else playerMarker = L.circleMarker(point, { radius: 9, color: '#2563eb', fillColor: '#60a5fa', fillOpacity: 1 }).addTo(map).bindPopup('You are here');
    map.setView(point, 18);
    placeButton.disabled = false;
    setStatus('Location found. Place a demo monster to test the hunt.');
  }, error => setStatus(`Could not get your location: ${error.message}`), { enableHighAccuracy: true, timeout: 10000 });
}

async function placeDemo() {
  if (!playerLocation) return;
  const response = await fetch('/api/demo-monster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(playerLocation) });
  const body = await response.json();
  setStatus(body.message || body.error);
  await loadMonsters();
}

async function capture(id) {
  if (!playerLocation) return setStatus('Find your location first.');
  const response = await fetch(`/api/monsters/${id}/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...playerLocation, playerName: hunterName() }) });
  const body = await response.json();
  setStatus(body.message || body.error);
  await loadMonsters();
}

document.querySelector('#locate').onclick = locate;
placeButton.onclick = placeDemo;
loadMonsters();
