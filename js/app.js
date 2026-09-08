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
    smooth: $('smooth'), night: $('night'), keepAwake: $('keepAwake')
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
    follow: true
  };

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
  let map = null, marker = null, trackLine = null, tiles = null;

  function initMap() {
    if (map || typeof L === 'undefined') return;
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([54.32, 10.14], 11);
    tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
    }).addTo(map);
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
    if (!map) return;
    const p = [lat, lon];
    if (!marker._map) marker.addTo(map);
    marker.setLatLng(p);
    // Nur das SVG drehen – die Transform des Icon-Containers gehört Leaflet.
    const icon = marker.getElement();
    const svg = icon && icon.querySelector('svg');
    if (svg) svg.style.transform = cog === null ? '' : `rotate(${cog}deg)`;

    state.track.push(p);
    if (state.track.length > MAX_TRACK_POINTS) state.track.shift();
    trackLine.setLatLngs(state.track);

    if (state.follow) map.setView(p, Math.max(map.getZoom(), 14), { animate: true });
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

    el.acc.textContent = c.accuracy === null || c.accuracy === undefined ? '–' : Math.round(c.accuracy);
    el.alt.textContent = (typeof c.altitude === 'number' && isFinite(c.altitude)) ? Math.round(c.altitude) : '–';
    el.hint.textContent = moving ? '' : 'Kurs erst ab ca. 1 kn Fahrt zuverlässig.';

    setBadge('live', 'GPS aktiv');
    updateMap(fix.lat, fix.lon, state.cog);
    render();
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
    tick();
  }

  function stop() {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    if (state.startedAt) { state.elapsedBefore = elapsed(); state.startedAt = null; }
    state.speed = null;
    state.cogFresh = false;
    setBadge('idle', 'GPS aus');
    el.hint.textContent = 'Aufzeichnung pausiert.';
    el.startBtn.textContent = 'Start';
    el.startBtn.classList.remove('running');
    releaseWakeLock();
    render();
  }

  function reset() {
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
    timer = setInterval(() => { if (state.startedAt) el.dur.textContent = fmtDuration(elapsed()); }, 1000);
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

  /* ---------- Start ---------- */
  setUnit(store.get('unit', 'kn'));
  el.smooth.value = store.get('smooth', '0.35');
  state.alpha = parseFloat(el.smooth.value);
  el.night.checked = store.get('night', '0') === '1';
  if (el.night.checked) document.body.classList.add('night');
  el.keepAwake.checked = store.get('keepAwake', '1') === '1';
  setFollow(true);
  initMap();
  updateNet();
  render();

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
    if (document.querySelector('.toast')) return;
    const box = document.createElement('div');
    box.className = 'toast';
    box.innerHTML = '<span>Neue Version verfügbar.</span>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = 'Neu laden';
    btn.addEventListener('click', () => location.reload());
    box.appendChild(btn);
    document.body.appendChild(box);
  }
})();
