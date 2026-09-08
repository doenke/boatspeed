/* Track-Aufzeichnung: Törns und Positionspunkte in IndexedDB, plus Export
   nach GPX und GeoJSON. Läuft vollständig offline; nichts verlässt das Gerät,
   solange nicht ausdrücklich exportiert oder hochgeladen wird. */
window.Track = (() => {
  'use strict';

  const DB_NAME = 'boatspeed';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('trips')) {
          db.createObjectStore('trips', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('points')) {
          const store = db.createObjectStore('points', { keyPath: 'id', autoIncrement: true });
          store.createIndex('trip', 'tripId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(stores, mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      result = work(t);
    }));
  }

  const asPromise = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  /* ---------- Törns ---------- */

  async function startTrip(name) {
    const trip = {
      name: name || defaultName(new Date()),
      startedAt: Date.now(),
      endedAt: null,
      points: 0,
      distance: 0,
      maxSpeed: 0,
      movingTime: 0
    };
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('trips', 'readwrite');
      const req = t.objectStore('trips').add(trip);
      req.onsuccess = () => { trip.id = req.result; resolve(trip); };
      t.onerror = () => reject(t.error);
    });
  }

  function defaultName(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `Törn ${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  async function updateTrip(id, patch) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('trips', 'readwrite');
      const store = t.objectStore('trips');
      const get = store.get(id);
      get.onsuccess = () => {
        const trip = get.result;
        if (!trip) { resolve(null); return; }
        Object.assign(trip, patch);
        store.put(trip);
        resolve(trip);
      };
      t.onerror = () => reject(t.error);
    });
  }

  async function addPoints(tripId, points) {
    if (!points.length) return;
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['points', 'trips'], 'readwrite');
      const store = t.objectStore('points');
      points.forEach((p) => store.add(Object.assign({ tripId }, p)));
      const trips = t.objectStore('trips');
      const get = trips.get(tripId);
      get.onsuccess = () => {
        const trip = get.result;
        if (trip) {
          trip.points = (trip.points || 0) + points.length;
          trips.put(trip);
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async function listTrips() {
    const db = await open();
    const trips = await asPromise(db.transaction('trips').objectStore('trips').getAll());
    return trips.sort((a, b) => b.startedAt - a.startedAt);
  }

  async function getTrip(id) {
    const db = await open();
    return asPromise(db.transaction('trips').objectStore('trips').get(id));
  }

  async function getPoints(tripId) {
    const db = await open();
    const idx = db.transaction('points').objectStore('points').index('trip');
    const points = await asPromise(idx.getAll(IDBKeyRange.only(tripId)));
    return points.sort((a, b) => a.t - b.t);
  }

  async function deleteTrip(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['points', 'trips'], 'readwrite');
      const idx = t.objectStore('points').index('trip');
      const cursor = idx.openCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) { c.delete(); c.continue(); }
      };
      t.objectStore('trips').delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  /** Nach einem Absturz offen gebliebene Törns sauber abschließen. */
  async function closeDangling() {
    const trips = await listTrips();
    for (const trip of trips) {
      if (trip.endedAt === null) {
        const points = await getPoints(trip.id);
        const last = points.length ? points[points.length - 1].t : trip.startedAt;
        await updateTrip(trip.id, { endedAt: last });
      }
    }
  }

  /* ---------- Export ---------- */

  const xml = (s) => String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const iso = (ms) => new Date(ms).toISOString();
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : null);

  function toGPX(trip, points) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="BoatSpeed"',
      '     xmlns="http://www.topografix.com/GPX/1/1"',
      '     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">',
      '  <metadata>',
      `    <name>${xml(trip.name)}</name>`,
      `    <time>${iso(trip.startedAt)}</time>`,
      '  </metadata>',
      '  <trk>',
      `    <name>${xml(trip.name)}</name>`,
      '    <trkseg>'
    ];
    for (const p of points) {
      lines.push(`      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`);
      const ele = num(p.alt, 1);
      if (ele !== null) lines.push(`        <ele>${ele}</ele>`);
      lines.push(`        <time>${iso(p.t)}</time>`);
      const spd = num(p.spd, 2);
      const cog = num(p.cog, 1);
      if (spd !== null || cog !== null) {
        lines.push('        <extensions><gpxtpx:TrackPointExtension>');
        if (spd !== null) lines.push(`          <gpxtpx:speed>${spd}</gpxtpx:speed>`);
        if (cog !== null) lines.push(`          <gpxtpx:course>${cog}</gpxtpx:course>`);
        lines.push('        </gpxtpx:TrackPointExtension></extensions>');
      }
      lines.push('      </trkpt>');
    }
    lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
    return lines.join('\n');
  }

  /* GeoJSON in der Form, die Dawarich beim Import erwartet:
     ein Point-Feature je Fix, Geschwindigkeit in m/s unter "speed",
     Kurs unter "heading", Genauigkeit unter "accuracy". */
  function toGeoJSON(trip, points) {
    const features = points.map((p) => {
      const coords = [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))];
      if (typeof p.alt === 'number' && isFinite(p.alt)) coords.push(Number(p.alt.toFixed(1)));
      const props = { timestamp: iso(p.t), tracker_id: 'boatspeed' };
      if (typeof p.spd === 'number' && isFinite(p.spd)) props.speed = Number(p.spd.toFixed(2));
      if (typeof p.cog === 'number' && isFinite(p.cog)) props.heading = Number(p.cog.toFixed(1));
      if (typeof p.acc === 'number' && isFinite(p.acc)) props.accuracy = Number(p.acc.toFixed(1));
      if (typeof p.alt === 'number' && isFinite(p.alt)) props.altitude = Number(p.alt.toFixed(1));
      return { type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: props };
    });
    return JSON.stringify({
      type: 'FeatureCollection',
      properties: { name: trip.name, created_by: 'BoatSpeed' },
      features
    });
  }

  /** Dateiname ohne Sonderzeichen – der Upload nutzt ihn als Import-Name. */
  function fileName(trip, ext) {
    const d = new Date(trip.startedAt);
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    // Buchstaben, die NFKD nicht zerlegt, weil sie keine Grundform mit
    // Akzent sind – ohne diese Liste würde aus "Ærøskøbing" ein "r-sk-bing".
    const LETTERS = {
      'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss',
      'æ': 'ae', 'ø': 'oe', 'å': 'aa', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l',
      'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue',
      'Æ': 'Ae', 'Ø': 'Oe', 'Å': 'Aa', 'Đ': 'D', 'Ð': 'D', 'Þ': 'Th', 'Ł': 'L'
    };
    const slug = trip.name
      .replace(/[äöüßæøåđðþłÄÖÜÆØÅĐÐÞŁ]/g, (c) => LETTERS[c])
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'toern';
    return `boatspeed-${stamp}-${slug}.${ext}`;
  }

  return {
    open, startTrip, updateTrip, addPoints, listTrips, getTrip, getPoints,
    deleteTrip, closeDangling, toGPX, toGeoJSON, fileName, defaultName
  };
})();
