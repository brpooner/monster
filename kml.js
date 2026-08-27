'use strict';

// Minimal, dependency-free KML reader for Google Earth exports.
// Pulls one point per <Placemark>: its <name> and <coordinates> (lon,lat[,alt]).
// Robust to the usual Google Earth output; ignores paths/polygons.

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').trim();
}

function parseKml(kml) {
  const out = [];
  if (!kml || typeof kml !== 'string') return out;

  const placemarks = kml.match(/<Placemark\b[\s\S]*?<\/Placemark>/gi) || [];
  for (const pm of placemarks) {
    const nameMatch = pm.match(/<name\b[^>]*>([\s\S]*?)<\/name>/i);
    const coordMatch = pm.match(/<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/i);
    if (!coordMatch) continue;

    // A Point has a single "lon,lat,alt". Take the first coordinate triple only.
    const first = coordMatch[1].trim().split(/\s+/)[0];
    if (!first) continue;
    const parts = first.split(',');
    const lon = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const name = nameMatch ? decodeEntities(nameMatch[1]) : '';
    out.push({ name, lat, lon });
  }
  return out;
}

module.exports = { parseKml };
