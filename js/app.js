/* BoatSpeed – Geschwindigkeit, Kurs und Position aus dem GPS des Geräts.
   Läuft komplett als statische Seite; Karte nur bei Internetverbindung
   (bereits besuchte Kacheln bleiben offline aus dem Cache verfügbar). */
(() => {
  'use strict';

  const UNITS = {
    ms:  { label: 'm/s',  factor: 1,                  digits: 1 },
    kmh: { label: 'km/h', factor: 3.6,                digits: 1 },
    kn:  { label: 'kn',   factor: 1.9438444924406046, digits: 1 }
  };
  const CARDINALS = ['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'];

  // Ab dieser Geschwindigkeit gilt der berechnete Kurs als brauchbar (GPS-Rauschen im Stand).
  const MOVING_MS = 0.5;
  const MAX_TRACK_POINTS = 5000;

  const $ = (id) => document.getElementById(id);
  const el = {
    speed: $('speed'), speedUnit: $('speedUnit'), hint: $('hint'),
    cog: $('cog'), cardinal: $('cardinal'), needle: $('needle'), ticks: $('ticks'),
    avg: $('avg'), max: $('max'), dist: $('dist'), dur: $('dur'), acc: $('acc'), alt: $('alt'),
    gpsBadge: $('gpsBadge'), netBadge: $('netBadge'),
    startBtn: $('startBtn'), resetBtn: $('resetBtn'), followBtn: $('followBtn'),
    installBtn: $('installBtn'), mapNote: $('mapNote'),
    smooth: $('smooth'), night: $('night'), keepAwake: $('keepAwake'),
    tripList: $('tripList'), tripSummary: $('tripSummary'),
    recMode: $('recMode'),
    dlg: $('dlg'), dlgTitle: $('dlgTitle'), dlgText: $('dlgText'),
    dlgInput: $('dlgInput'), dlgOk: $('dlgOk'),
    seamarkBtn: $('seamarkBtn'), ecoMode: $('ecoMode'), ecoNote: $('ecoNote'),
    mobBtn: $('mobBtn'), mobCard: $('mobCard'), mobAge: $('mobAge'),
    mobBearing: $('mobBearing'), mobDistance: $('mobDistance'),
    mobDistUnit: $('mobDistUnit'), mobPos: $('mobPos'), mobClearBtn: $('mobClearBtn')
  };

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('boatspeed.' + key); return v === null ? fallback : v; }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('boatspeed.' + key, value); } catch { /* Privatmodus */ }
    }
  };

  const state = {
    unit: 'kn',
    alpha: 1,
    watchId: null,
    wakeLock: null,
    last: null,          // { lat, lon, t }
    speed: null,         // geglättet, m/s
    cog: null,           // Grad
    cogFresh: false,
    maxSpeed: 0,
    distance: 0,         // Meter
    movingTime: 0,       // Sekunden mit Fahrt
    startedAt: null,
    elapsedBefore: 0,
    track: [],
    follow: true,
    // Aufzeichnung
    tripId: null,
    buffer: [],
    lastStored: null,
    minDist: 5,
    seamarks: false,
    eco: false,
    mob: null,           // { lat, lon, t }
    lastRender: 0
  };

  // Im Sparmodus wird die Anzeige nur noch im Sekundentakt neu gezeichnet.
  const ECO_RENDER_MS = 1000;

  // Wie dicht wird aufgezeichnet? Kleinster Abstand in Metern, "aus" = nicht.
  const REC_MODES = { fein: 2, normal: 5, sparsam: 25, aus: null };
  // Unabhängig davon spätestens nach dieser Zeit einen Punkt sichern.
  const REC_MAX_GAP = 30000;
  const REC_MIN_GAP = 2000;

  /* ---------- Geometrie ---------- */
  const R = 6371008.8; // mittlerer Erdradius, m
  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;

  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 +
              Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(a, b) {
    const dLon = rad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
              Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  /* ---------- Formatierung ---------- */
  const fmtSpeed = (ms) => {
    if (ms === null || !isFinite(ms)) return '--.-';
    const u = UNITS[state.unit];
    return (ms * u.factor).toFixed(u.digits);
  };

  function fmtDuration(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    return `${h}:${m}:${String(s % 60).padStart(2, '0')}`;
  }

  const cardinal = (d) => CARDINALS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];

  /* ---------- Kompassrose ---------- */
  (function drawTicks() {
    const ns = 'http://www.w3.org/2000/svg';
    for (let a = 0; a < 360; a += 15) {
      const long = a % 90 === 0;
      const r1 = 92, r2 = long ? 78 : 84;
      const t = rad(a - 90);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', 100 + r1 * Math.cos(t));
      line.setAttribute('y1', 100 + r1 * Math.sin(t));
      line.setAttribute('x2', 100 + r2 * Math.cos(t));
      line.setAttribute('y2', 100 + r2 * Math.sin(t));
      line.setAttribute('class', 'tick');
      el.ticks.appendChild(line);
    }
  })();

  /* ---------- Karte ---------- */
  let map = null, marker = null, trackLine = null, tiles = null, seamarks = null, mobMarker = null;

  // Ein 1x1 durchsichtiges PNG: fehlende Seezeichen-Kacheln sollen die Karte
  // nicht mit Fehlerbildern übersäen.
  const BLANK_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAA'
    + 'AC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  function initMap() {
    if (map || typeof L === 'undefined') return;
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([54.32, 10.14], 11);
    tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
    }).addTo(map);

    // Seezeichen von OpenSeaMap: durchsichtige Kacheln, die nur Tonnen, Feuer
    // und Hafensymbole enthalten – sie gehören über die Grundkarte, nicht
    // an deren Stelle.
    seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      maxZoom: 18,
      maxNativeZoom: 18,
      opacity: 1,
      errorTileUrl: BLANK_TILE,
      attribution: '&copy; <a href="https://www.openseamap.org/">OpenSeaMap</a>-Mitwirkende'
    });
    trackLine = L.polyline([], { color: '#38bdf8', weight: 3, opacity: .85 }).addTo(map);
    marker = L.marker([54.32, 10.14], {
      icon: L.divIcon({
        className: 'boat-icon',
        html: '<svg width="34" height="34" viewBox="0 0 34 34"><polygon points="17,2 27,31 17,24 7,31" fill="#38bdf8" stroke="#04121c" stroke-width="1.5"/></svg>',
        iconSize: [34, 34], iconAnchor: [17, 17]
      })
    });
    // Sobald der Nutzer die Karte selbst bewegt, nicht mehr automatisch folgen.
    map.on('dragstart', () => setFollow(false));
  }

  function updateMap(lat, lon, cog) {
    const p = [lat, lon];
    state.track.push(p);
    if (state.track.length > MAX_TRACK_POINTS) state.track.shift();
    // Im Sparmodus ist die Karte ausgeblendet; der Track wird trotzdem
    // mitgeführt, damit er beim Zurückschalten vollständig da ist.
    if (!map || state.eco) return;
    if (!marker._map) marker.addTo(map);
    marker.setLatLng(p);
    // Nur das SVG drehen – die Transform des Icon-Containers gehört Leaflet.
    const icon = marker.getElement();
    const svg = icon && icon.querySelector('svg');
    if (svg) svg.style.transform = cog === null ? '' : `rotate(${cog}deg)`;

    trackLine.setLatLngs(state.track);

    if (state.follow) map.setView(p, Math.max(map.getZoom(), 14), { animate: true });
  }

  function setSeamarks(on) {
    state.seamarks = on;
    el.seamarkBtn.setAttribute('aria-pressed', String(on));
    store.set('seamarks', on ? '1' : '0');
    if (!seamarks || !map) return;
    if (on && !map.hasLayer(seamarks)) seamarks.addTo(map);
    if (!on && map.hasLayer(seamarks)) map.removeLayer(seamarks);
  }

  function setFollow(on) {
    state.follow = on;
    el.followBtn.setAttribute('aria-pressed', String(on));
    el.followBtn.textContent = on ? 'Folgen' : 'Frei';
  }

  /* ---------- Netzstatus ---------- */
  function updateNet() {
    const online = navigator.onLine;
    el.netBadge.textContent = online ? 'Online' : 'Offline';
    el.netBadge.className = 'badge ' + (online ? 'badge-live' : 'badge-wait');
    el.mapNote.hidden = online;
    if (!online) {
      el.mapNote.textContent = 'Offline – es werden nur bereits geladene Kartenkacheln angezeigt. ' +
                               'Geschwindigkeit und Kurs funktionieren ohne Internet.';
    }
  }

  /* ---------- Anzeige ---------- */
  function render() {
    el.speed.textContent = fmtSpeed(state.speed);
    const label = UNITS[state.unit].label;
    el.speedUnit.textContent = label;
    document.querySelectorAll('[data-unit-label]').forEach((n) => { n.textContent = label; });
    el.max.textContent = fmtSpeed(state.maxSpeed || null);
    el.avg.textContent = fmtSpeed(state.movingTime > 3 ? state.distance / state.movingTime : null);
    el.dist.textContent = (state.distance / 1852).toFixed(2);
    el.dur.textContent = fmtDuration(elapsed());

    if (state.cog === null) {
      el.cog.textContent = '---';
      el.cardinal.textContent = '–';
      el.needle.classList.add('stale');
    } else {
      el.cog.textContent = String(Math.round(state.cog) % 360).padStart(3, '0');
      el.cardinal.textContent = cardinal(state.cog);
      el.needle.style.transform = `rotate(${state.cog}deg)`;
      el.needle.classList.toggle('stale', !state.cogFresh);
    }
  }

  const elapsed = () =>
    state.elapsedBefore + (state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0);

  /* ---------- GPS ---------- */
  function onPosition(pos) {
    const c = pos.coords;
    const now = pos.timestamp || Date.now();
    const fix = { lat: c.latitude, lon: c.longitude, t: now };

    let raw = (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) ? c.speed : null;
    let course = (typeof c.heading === 'number' && isFinite(c.heading)) ? c.heading : null;
    let segment = 0;

    if (state.last) {
      const dt = (now - state.last.t) / 1000;
      segment = haversine(state.last, fix);
      if (dt > 0.2 && dt < 30) {
        // Fällt das Gerät für Geschwindigkeit/Kurs aus, aus zwei Fixes rechnen.
        if (raw === null) raw = segment / dt;
        if (course === null && segment > Math.max(3, (c.accuracy || 0) * 0.5)) {
          course = bearing(state.last, fix);
        }
        // Strecke nur zählen, wenn die Bewegung deutlich über dem Messrauschen liegt.
        if (segment > Math.max(2, (c.accuracy || 0) * 0.5)) state.distance += segment;
        if (raw !== null && raw > MOVING_MS) state.movingTime += dt;
      }
    }

    if (raw !== null) {
      state.speed = (state.speed === null || state.alpha >= 1)
        ? raw
        : state.speed + state.alpha * (raw - state.speed);
      if (state.speed > state.maxSpeed) state.maxSpeed = state.speed;
    }

    const moving = state.speed !== null && state.speed > MOVING_MS;
    if (course !== null && moving) {
      state.cog = course;
      state.cogFresh = true;
    } else if (!moving) {
      state.cogFresh = false; // letzter Kurs bleibt stehen, wird aber ausgegraut
    }

    state.last = fix;
    recordPoint(fix, c);

    el.acc.textContent = c.accuracy === null || c.accuracy === undefined ? '–' : Math.round(c.accuracy);
    el.alt.textContent = (typeof c.altitude === 'number' && isFinite(c.altitude)) ? Math.round(c.altitude) : '–';
    el.hint.textContent = moving ? '' : 'Kurs erst ab ca. 1 kn Fahrt zuverlässig.';

    setBadge('live', 'GPS aktiv');
    updateMap(fix.lat, fix.lon, state.cog);
    if (state.mob) renderMOB();

    // Im Sparmodus reicht eine Aktualisierung je Sekunde; jeder Neuaufbau
    // der Anzeige kostet Rechenzeit und damit Akku.
    const tNow = Date.now();
    if (!state.eco || tNow - state.lastRender >= ECO_RENDER_MS) {
      state.lastRender = tNow;
      render();
    }
  }

  function onError(err) {
    const msg = {
      1: 'Standortfreigabe verweigert – bitte in den Browser-/App-Einstellungen erlauben.',
      2: 'Kein Positionssignal. Freie Sicht zum Himmel hilft.',
      3: 'Zeitüberschreitung beim Positionsempfang.'
    }[err.code] || ('Standortfehler: ' + err.message);
    el.hint.textContent = msg;
    setBadge(err.code === 1 ? 'err' : 'wait', err.code === 1 ? 'GPS blockiert' : 'GPS sucht');
  }

  function setBadge(kind, text) {
    el.gpsBadge.className = 'badge badge-' + kind;
    el.gpsBadge.textContent = text;
  }

  function start() {
    if (!('geolocation' in navigator)) {
      el.hint.textContent = 'Dieses Gerät liefert keine Standortdaten.';
      return;
    }
    if (!window.isSecureContext) {
      el.hint.textContent = 'Standort braucht HTTPS (oder localhost).';
      return;
    }
    state.startedAt = Date.now();
    state.watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    });
    setBadge('wait', 'GPS sucht');
    el.hint.textContent = 'Warte auf Positionsfix …';
    el.startBtn.textContent = 'Stopp';
    el.startBtn.classList.add('running');
    requestWakeLock();
    beginTrip();
    tick();
  }

  function stop() {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    if (state.startedAt) { state.elapsedBefore = elapsed(); state.startedAt = null; }
    state.speed = null;
    state.cogFresh = false;
    finishTrip();
    setBadge('idle', 'GPS aus');
    el.hint.textContent = 'Aufzeichnung pausiert.';
    el.startBtn.textContent = 'Start';
    el.startBtn.classList.remove('running');
    releaseWakeLock();
    render();
  }

  function reset() {
    // Läuft gerade eine Aufzeichnung, wird der bisherige Törn abgeschlossen
    // und ein neuer begonnen – die Statistik gehört dann zum neuen Törn.
    if (state.tripId !== null) {
      finishTrip().then(beginTrip);
    }
    state.last = null;
    state.speed = null;
    state.cog = null;
    state.cogFresh = false;
    state.maxSpeed = 0;
    state.distance = 0;
    state.movingTime = 0;
    state.elapsedBefore = 0;
    state.startedAt = state.watchId !== null ? Date.now() : null;
    state.track = [];
    if (trackLine) trackLine.setLatLngs([]);
    render();
  }

  let timer = null;
  function tick() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (state.startedAt) el.dur.textContent = fmtDuration(elapsed());
      if (state.mob) el.mobAge.textContent = 'vor ' + fmtDuration((Date.now() - state.mob.t) / 1000);
    }, 1000);
  }

  /* ---------- Wake Lock ---------- */
  async function requestWakeLock() {
    if (!el.keepAwake.checked || !('wakeLock' in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch { /* z.B. bei niedrigem Akkustand */ }
  }
  function releaseWakeLock() {
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.watchId !== null) requestWakeLock();
  });

  /* ---------- Bedienung ---------- */
  function setUnit(unit) {
    state.unit = UNITS[unit] ? unit : 'kn';
    document.querySelectorAll('.unit').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));
    store.set('unit', state.unit);
    render();
  }

  document.querySelectorAll('.unit').forEach((b) =>
    b.addEventListener('click', () => setUnit(b.dataset.unit)));

  el.startBtn.addEventListener('click', () => (state.watchId === null ? start() : stop()));
  el.resetBtn.addEventListener('click', reset);
  el.followBtn.addEventListener('click', () => setFollow(!state.follow));

  el.smooth.addEventListener('change', () => {
    state.alpha = parseFloat(el.smooth.value);
    store.set('smooth', el.smooth.value);
  });

  el.night.addEventListener('change', () => {
    document.body.classList.toggle('night', el.night.checked);
    store.set('night', el.night.checked ? '1' : '0');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = el.night.checked ? '#170303' : '#0b1622';
  });

  el.keepAwake.addEventListener('change', () => {
    store.set('keepAwake', el.keepAwake.checked ? '1' : '0');
    if (el.keepAwake.checked) requestWakeLock(); else releaseWakeLock();
  });

  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);

  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    el.installBtn.hidden = false;
  });
  el.installBtn.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    el.installBtn.hidden = true;
  });


  /* ---------- Aufzeichnung ---------- */

  /** Punkt sichern, wenn genug Strecke oder genug Zeit vergangen ist. */
  function recordPoint(fix, coords) {
    if (state.tripId === null || state.minDist === null) return;
    const prev = state.lastStored;
    if (prev) {
      const dt = fix.t - prev.t;
      if (dt < REC_MIN_GAP) return;
      if (haversine(prev, fix) < state.minDist && dt < REC_MAX_GAP) return;
    }
    const numberOr = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    state.buffer.push({
      t: fix.t,
      lat: fix.lat,
      lon: fix.lon,
      spd: numberOr(state.speed),
      cog: state.cogFresh ? numberOr(state.cog) : null,
      alt: numberOr(coords.altitude),
      acc: numberOr(coords.accuracy)
    });
    state.lastStored = fix;
    if (state.buffer.length >= 12) flushBuffer();
  }

  /** Gepufferte Punkte schreiben – gebündelt, um die Datenbank zu schonen. */
  async function flushBuffer() {
    if (!state.buffer.length || state.tripId === null) return;
    const id = state.tripId;
    const batch = state.buffer.splice(0, state.buffer.length);
    try {
      await Track.addPoints(id, batch);
      renderTrips();
    } catch (err) {
      state.buffer.unshift(...batch); // beim nächsten Versuch erneut probieren
    }
  }

  async function beginTrip() {
    if (state.minDist === null || state.tripId !== null) return;
    try {
      const trip = await Track.startTrip();
      state.tripId = trip.id;
      state.lastStored = null;
      renderTrips();
    } catch (err) {
      toast('Aufzeichnung nicht möglich: ' + err.message);
    }
  }

  async function finishTrip() {
    if (state.tripId === null) return;
    const id = state.tripId;
    // Zahlenstand sofort sichern: reset() leert die Statistik direkt nach
    // diesem Aufruf, noch bevor der erste await zurückkommt.
    const stats = {
      endedAt: Date.now(),
      distance: state.distance,
      maxSpeed: state.maxSpeed,
      movingTime: state.movingTime
    };
    await flushBuffer();
    state.tripId = null;
    state.lastStored = null;
    try {
      await Track.updateTrip(id, stats);
    } catch (err) { /* Törn bleibt notfalls offen und wird beim Start repariert */ }
    renderTrips();
  }

  // Beim Wegschalten oder Schließen nichts verlieren.
  window.addEventListener('pagehide', () => { flushBuffer(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBuffer();
  });

  /* ---------- Törnliste ---------- */

  function tripStats(trip) {
    const parts = [];
    if (trip.distance) parts.push((trip.distance / 1852).toFixed(2) + ' sm');
    const secs = ((trip.endedAt || Date.now()) - trip.startedAt) / 1000;
    parts.push(fmtDuration(secs));
    parts.push((trip.points || 0) + ' Pkt.');
    if (trip.maxSpeed) parts.push('max ' + fmtSpeed(trip.maxSpeed) + ' ' + UNITS[state.unit].label);
    return parts.join(' · ');
  }

  async function renderTrips() {
    let trips;
    try {
      trips = await Track.listTrips();
    } catch (err) {
      el.tripSummary.textContent = 'Speicher nicht verfügbar';
      return;
    }
    const total = trips.reduce((sum, t) => sum + (t.distance || 0), 0);
    el.tripSummary.textContent = trips.length
      ? `${trips.length} · ${(total / 1852).toFixed(1)} sm gesamt`
      : 'noch keine';

    el.tripList.textContent = '';
    for (const trip of trips) {
      el.tripList.appendChild(tripItem(trip));
    }
  }

  function tripItem(trip) {
    const li = document.createElement('li');
    li.className = 'trip';
    li.dataset.id = String(trip.id);

    const head = document.createElement('div');
    head.className = 'trip-head';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'trip-name';
    name.textContent = trip.name;
    name.title = 'Umbenennen';
    name.dataset.act = 'rename';
    head.appendChild(name);
    if (trip.endedAt === null) {
      const live = document.createElement('span');
      live.className = 'badge badge-live';
      live.textContent = 'läuft';
      head.appendChild(live);
    }
    li.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'trip-meta';
    meta.textContent = tripStats(trip);
    li.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'trip-actions';
    // Auf dem Handy öffnet der Export den Teilen-Dialog, am Rechner lädt er
    // die Datei herunter – die Beschriftung sagt, was passiert.
    const buttons = [
      ['geojson', canShareFiles() ? 'Teilen' : 'GeoJSON'],
      ['gpx', 'GPX'],
      ['delete', 'Löschen']
    ];
    buttons.forEach(([act, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (act === 'delete' ? ' danger' : '');
      b.dataset.act = act;
      b.textContent = label;
      if (!trip.points) b.disabled = act !== 'delete';
      actions.appendChild(b);
    });
    li.appendChild(actions);
    return li;
  }

  el.tripList.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    const item = ev.target.closest('.trip');
    if (!btn || !item) return;
    const trip = await Track.getTrip(Number(item.dataset.id));
    if (!trip) return;

    try {
      if (btn.dataset.act === 'rename') {
        const name = await ask({
          title: 'Törn umbenennen',
          value: trip.name,
          okLabel: 'Übernehmen'
        });
        if (name) {
          await Track.updateTrip(trip.id, { name });
          renderTrips();
        }
      } else if (btn.dataset.act === 'delete') {
        const ok = await ask({
          title: 'Törn löschen?',
          text: `„${trip.name}“ mit ${trip.points || 0} Punkten wird endgültig entfernt.`,
          okLabel: 'Löschen',
          danger: true
        });
        if (ok) {
          if (trip.id === state.tripId) {
            state.tripId = null;
            state.buffer = [];
          }
          await Track.deleteTrip(trip.id);
          renderTrips();
        }
      } else {
        await exportTrip(trip, btn.dataset.act);
      }
    } catch (err) {
      toast(err.message || String(err));
    }
  });

  /* ---------- Mann über Bord ---------- */

  /* Ein Druck genügt: in der Lage zählt jede Sekunde, also keine Rückfrage.
     Das Löschen dagegen wird abgefragt, damit die Marke nicht versehentlich
     verschwindet. Sie überlebt Neuladen und Appwechsel. */
  function markMOB() {
    const fix = state.last;
    if (!fix) {
      toast('Noch keine Position – ohne GPS-Fix lässt sich nichts markieren.');
      return;
    }
    state.mob = { lat: fix.lat, lon: fix.lon, t: Date.now() };
    store.set('mob', JSON.stringify(state.mob));
    renderMOB();
    el.mobCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function clearMOB() {
    const ok = await ask({
      title: 'Markierung löschen?',
      text: 'Die MOB-Position geht verloren.',
      okLabel: 'Löschen',
      danger: true
    });
    if (!ok) return;
    state.mob = null;
    store.set('mob', '');
    renderMOB();
  }

  /** Peilung, Distanz und Alter der Marke – wird bei jedem Fix aufgefrischt. */
  function renderMOB() {
    const mob = state.mob;
    el.mobCard.hidden = !mob;
    // Beschriftung bleibt kurz und konstant; gesetzt oder nicht zeigt der
    // Rahmen. Ein erneuter Druck versetzt die Marke auf die jetzige Position.
    el.mobBtn.classList.toggle('armed', !!mob);
    el.mobBtn.title = mob
      ? 'Markierung auf die aktuelle Position versetzen'
      : 'Aktuelle Position sofort markieren';

    if (mobMarker && map && map.hasLayer(mobMarker) && !mob) {
      map.removeLayer(mobMarker);
    }
    if (!mob) return;

    if (state.last) {
      const d = haversine(state.last, mob);
      el.mobDistance.textContent = d < 1852 ? Math.round(d) : (d / 1852).toFixed(2);
      el.mobDistUnit.textContent = d < 1852 ? 'm' : 'sm';
      const brg = bearing(state.last, mob);
      el.mobBearing.textContent = String(Math.round(brg) % 360).padStart(3, '0');
    } else {
      el.mobDistance.textContent = '–';
      el.mobBearing.textContent = '---';
    }
    el.mobPos.textContent = formatPosition(mob.lat, mob.lon);
    el.mobAge.textContent = 'vor ' + fmtDuration((Date.now() - mob.t) / 1000);

    if (map && !state.eco) {
      if (!mobMarker) {
        mobMarker = L.marker([mob.lat, mob.lon], {
          icon: L.divIcon({
            className: 'mob-icon',
            html: '<svg width="30" height="30" viewBox="0 0 30 30">'
                + '<circle cx="15" cy="15" r="11" fill="none" stroke="#f87171" stroke-width="3"/>'
                + '<line x1="15" y1="3" x2="15" y2="27" stroke="#f87171" stroke-width="3"/>'
                + '<line x1="3" y1="15" x2="27" y2="15" stroke="#f87171" stroke-width="3"/></svg>',
            iconSize: [30, 30], iconAnchor: [15, 15]
          })
        });
      }
      mobMarker.setLatLng([mob.lat, mob.lon]);
      if (!map.hasLayer(mobMarker)) mobMarker.addTo(map);
    }
  }

  /** Grad und Dezimalminuten – so steht es auch in der Seekarte. */
  function formatPosition(lat, lon) {
    const part = (value, positive, negative, degDigits) => {
      const hemisphere = value >= 0 ? positive : negative;
      const abs = Math.abs(value);
      const deg = Math.floor(abs);
      const min = (abs - deg) * 60;
      return `${String(deg).padStart(degDigits, '0')}° ${min.toFixed(3).padStart(6, '0')}' ${hemisphere}`;
    };
    return part(lat, 'N', 'S', 2) + ' / ' + part(lon, 'E', 'W', 3);
  }

  el.mobBtn.addEventListener('click', markMOB);
  el.mobClearBtn.addEventListener('click', clearMOB);

  /* ---------- Sparmodus ---------- */

  /* Der größte Verbraucher ist das Display, danach das Nachladen und Zeichnen
     der Karte. Beides lässt sich abschalten, ohne die Ortung anzutasten –
     die läuft unverändert weiter, ebenso die Aufzeichnung. */
  function setEco(on) {
    state.eco = on;
    document.body.classList.toggle('eco', on);
    el.ecoNote.hidden = !on;
    el.ecoMode.checked = on;
    store.set('eco', on ? '1' : '0');
    if (!on && map) {
      // Beim Zurückschalten die Karte auf den aktuellen Stand bringen.
      map.invalidateSize();
      if (trackLine) trackLine.setLatLngs(state.track);
      if (state.last) updateMap(state.last.lat, state.last.lon, state.cog);
      renderMOB();
    }
  }

  el.ecoMode.addEventListener('change', () => setEco(el.ecoMode.checked));
  el.seamarkBtn.addEventListener('click', () => setSeamarks(!state.seamarks));

  /* ---------- Dialog ---------- */

  /**
   * Eigener Dialog statt prompt()/confirm(): Mit "value" fragt er einen Text
   * ab und liefert ihn zurück, ohne "value" ist er eine Rückfrage und liefert
   * true. Abbruch, Escape und ein Klick neben den Dialog ergeben null.
   */
  function ask({ title, text, value, okLabel, danger }) {
    const wantsText = typeof value === 'string';
    el.dlgTitle.textContent = title;
    el.dlgText.textContent = text || '';
    el.dlgText.hidden = !text;
    el.dlgInput.hidden = !wantsText;
    el.dlgInput.value = wantsText ? value : '';
    el.dlgOk.textContent = okLabel || 'Speichern';
    el.dlgOk.classList.toggle('danger-btn', !!danger);

    return new Promise((resolve) => {
      const onClose = () => {
        el.dlg.removeEventListener('close', onClose);
        if (el.dlg.returnValue !== 'ok') { resolve(null); return; }
        resolve(wantsText ? el.dlgInput.value.trim() : true);
      };
      el.dlg.addEventListener('close', onClose);
      el.dlg.returnValue = '';
      el.dlg.showModal();
      if (wantsText) {
        el.dlgInput.focus();
        el.dlgInput.select();
      } else {
        el.dlgOk.focus();
      }
    });
  }

  // Klick auf den Hintergrund schließt den Dialog wie ein Abbruch.
  el.dlg.addEventListener('click', (ev) => {
    if (ev.target === el.dlg) el.dlg.close('cancel');
  });

  /* ---------- Export ---------- */

  async function buildExport(trip, kind) {
    if (trip.id === state.tripId) await flushBuffer();
    const points = await Track.getPoints(trip.id);
    if (!points.length) throw new Error('Dieser Törn enthält noch keine Punkte.');
    const gpx = kind === 'gpx';
    const text = gpx ? Track.toGPX(trip, points) : Track.toGeoJSON(trip, points);
    return {
      blob: new Blob([text], { type: gpx ? 'application/gpx+xml' : 'application/geo+json' }),
      name: Track.fileName(trip, gpx ? 'gpx' : 'geojson'),
      count: points.length
    };
  }

  function canShareFiles() {
    if (typeof File !== 'function' || !navigator.canShare) return false;
    try {
      return navigator.canShare({ files: [new File([''], 'probe.txt', { type: 'text/plain' })] });
    } catch (err) {
      return false;
    }
  }

  async function exportTrip(trip, kind) {
    const { blob, name } = await buildExport(trip, kind);
    // Auf dem Handy ist der Teilen-Dialog bequemer als ein Download.
    if (typeof File === 'function' && navigator.canShare) {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: trip.name });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  el.recMode.addEventListener('change', () => {
    state.minDist = REC_MODES[el.recMode.value];
    store.set('recMode', el.recMode.value);
    if (state.minDist === null) {
      finishTrip();
    } else if (state.watchId !== null && state.tripId === null) {
      beginTrip();
    }
  });

  /* ---------- Start ---------- */
  setUnit(store.get('unit', 'kn'));
  el.smooth.value = store.get('smooth', '0.35');
  state.alpha = parseFloat(el.smooth.value);
  el.night.checked = store.get('night', '0') === '1';
  if (el.night.checked) document.body.classList.add('night');
  el.keepAwake.checked = store.get('keepAwake', '1') === '1';
  const savedMode = store.get('recMode', 'normal');
  el.recMode.value = Object.prototype.hasOwnProperty.call(REC_MODES, savedMode) ? savedMode : 'normal';
  state.minDist = REC_MODES[el.recMode.value];
  setFollow(true);
  initMap();
  setSeamarks(store.get('seamarks', '0') === '1');
  setEco(store.get('eco', '0') === '1');
  updateNet();
  render();

  // Eine gesetzte MOB-Marke überlebt Neuladen und Appwechsel.
  try {
    const saved = JSON.parse(store.get('mob', '') || 'null');
    if (saved && isFinite(saved.lat) && isFinite(saved.lon)) state.mob = saved;
  } catch (err) { /* beschädigter Eintrag wird verworfen */ }
  renderMOB();
  tick();

  // Nach einem Absturz offen gebliebene Törns schließen, dann Liste zeigen.
  Track.closeDangling().then(renderTrips).catch(() => renderTrips());

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    // Nach einem Deploy übernimmt der neue Service Worker sofort; nur dann,
    // wenn vorher schon einer aktiv war, ist das ein echtes Update.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) showUpdateToast();
    });
  }

  function showUpdateToast() {
    toast('Neue Version verfügbar.', 'Neu laden', () => location.reload());
  }

  let toastTimer = null;
  function toast(text, actionLabel, action) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const box = document.createElement('div');
    box.className = 'toast';
    const span = document.createElement('span');
    span.textContent = text;
    box.appendChild(span);
    if (actionLabel) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => { box.remove(); action(); });
      box.appendChild(btn);
    }
    document.body.appendChild(box);
    clearTimeout(toastTimer);
    if (!actionLabel) toastTimer = setTimeout(() => box.remove(), 6000);
  }
})();
