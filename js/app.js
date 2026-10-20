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

  /* Stillstandserkennung.
     Im Stand streuen die Fixes unabhängig voneinander um dieselbe wahre Lage.
     Der Versatz zwischen erstem und letztem Fix bleibt deshalb im Rahmen der
     Messunsicherheit, ganz gleich wie lang das Fenster ist. Echte Fahrt
     dagegen wächst linear mit der Zeit. Genau daran lassen sich beide
     trennen – und daran zeigt sich auch, wie lang das Fenster sein muss: Bei
     6 m Genauigkeit braucht 1 kn rund eine halbe Minute, bis der Versatz aus
     dem Rauschen ragt. Deshalb mehrere Fenster nebeneinander – schnelle
     Fahrt wird früh erkannt, langsames Vertreiben später, aber eben doch. */
  const HISTORY_MS = 65000;
  const WINDOWS_MS = [5000, 15000, 60000];
  const CONF = 3;          // nötiger Versatz als Vielfaches der Unsicherheit
  const CONF_KEEP = 1.8;   // gelockert, solange bereits Fahrt erkannt ist
  const MIN_VOTES = 2;     // zwei Fixes in Folge, gegen einzelne Ausreißer
  const MIN_BASELINE_S = 3;
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
    mobDistUnit: $('mobDistUnit'), mobPos: $('mobPos'), mobClearBtn: $('mobClearBtn'),
    wxAge: $('wxAge'), wxRefresh: $('wxRefresh'), wxNow: $('wxNow'),
    wxWind: $('wxWind'), wxWindUnit: $('wxWindUnit'), wxBft: $('wxBft'),
    wxGust: $('wxGust'), wxGustUnit: $('wxGustUnit'), wxDir: $('wxDir'),
    wxDirArrow: $('wxDirArrow'), wxWave: $('wxWave'), wxTemp: $('wxTemp'),
    wxText: $('wxText'), wxChart: $('wxChart'), wxStatus: $('wxStatus'),
    wxCard: $('wxCard'), wxPlace: $('wxPlace'), wxTabs: $('wxTabs')
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
    history: [],         // letzte Fixes für die Stillstandserkennung
    still: null,         // true = Stillstand, false = Fahrt, null = unklar
    votes: 0,            // aufeinanderfolgende Fixes mit erkannter Bewegung
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

  let wxTab = 'wind';

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

  function pushHistory(fix, accuracy) {
    state.history.push({ lat: fix.lat, lon: fix.lon, t: fix.t, acc: accuracy });
    const cutoff = fix.t - HISTORY_MS;
    while (state.history.length > 2 && state.history[0].t < cutoff) state.history.shift();
  }

  /** Ältester Fix, der mindestens `ms` zurückliegt – sonst der älteste. */
  function baseline(ms) {
    const h = state.history;
    if (h.length < 2) return null;
    const newest = h[h.length - 1];
    for (let i = h.length - 2; i >= 0; i--) {
      if (newest.t - h[i].t >= ms) return h[i];
    }
    return h[0];
  }

  /**
   * Strecke und Zeit über ein Fenster. `moving` vergleicht die zurückgelegte
   * Strecke mit dem, was die gemeldete Messgenauigkeit an Zufallsversatz
   * hergibt – nur darüber gilt es als echte Fahrt.
   */
  function windowMotion(ms) {
    const from = baseline(ms);
    if (!from) return null;
    const to = state.history[state.history.length - 1];
    const dt = (to.t - from.t) / 1000;
    if (dt < MIN_BASELINE_S) return null;
    const net = haversine(from, to);
    const sigma = ((from.acc || 10) + (to.acc || 10)) / 2;
    return { from, to, net, dt, speed: net / dt, sigma };
  }

  /**
   * Kürzestes Fenster, in dem der Versatz sicher über der Messunsicherheit
   * liegt. Kurz heißt wenig Verzögerung – erst wenn das kurze Fenster nichts
   * hergibt, wird über eine längere Strecke gemessen.
   * Rückgabe: Fenster bei Fahrt, false bei Stillstand, null wenn die
   * Beobachtung für eine Aussage noch nicht reicht.
   */
  function motionEstimate() {
    const needed = state.still === false ? CONF_KEEP : CONF;
    let measured = false;
    let ceiling = Infinity;   // was kürzere Fenster bereits ausgeschlossen haben

    for (const ms of WINDOWS_MS) {
      const m = windowMotion(ms);
      if (!m) continue;
      measured = true;

      if (m.net > needed * m.sigma) {
        /* Ein langes Fenster darf nicht mehr Fahrt behaupten, als ein kurzes
           schon ausgeschlossen hat. Sonst überspannt es einen Wechsel – nach
           dem Stoppen hielte es die Anzeige noch eine Minute lang oben. */
        return m.speed <= ceiling ? m : false;
      }

      // Nichts gefunden: damit ist alles oberhalb dieser Schwelle ausgeschlossen.
      ceiling = Math.min(ceiling, (needed * m.sigma) / m.dt);
    }
    return measured ? false : null;
  }

  function onPosition(pos) {
    const c = pos.coords;
    const now = pos.timestamp || Date.now();
    const fix = { lat: c.latitude, lon: c.longitude, t: now };

    pushHistory(fix, c.accuracy);

    let raw = (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) ? c.speed : null;
    let course = (typeof c.heading === 'number' && isFinite(c.heading)) ? c.heading : null;
    let segment = 0;

    const leg = motionEstimate();
    if (leg !== null) {
      // Ein einzelner Ausreißer soll die Anzeige nicht aufwecken.
      state.votes = leg ? Math.min(MIN_VOTES, state.votes + 1) : 0;
      state.still = state.votes < MIN_VOTES;
    }

    if (state.still === true) {
      /* Im Stand liefert jedes GPS einen Zufallsversatz von einigen Metern.
         Von Fix zu Fix gerechnet ergibt das mehrere Knoten – und Glätten hilft
         dagegen grundsätzlich nicht, weil Geschwindigkeit ein Betrag ist:
         gemitteltes Rauschen bleibt positiv. Steht das Boot, wird die Fahrt
         deshalb auf null gesetzt statt gefiltert. */
      raw = 0;
      course = null;
    }

    if (state.last) {
      const dt = (now - state.last.t) / 1000;
      segment = haversine(state.last, fix);
      if (dt > 0.2 && dt < 30 && state.still !== true) {
        // Fällt das Gerät für Geschwindigkeit/Kurs aus, über ein paar Sekunden
        // messen statt von Fix zu Fix – das dämpft den Zufallsversatz. Solange
        // das Fenster für ein Urteil nicht reicht, bleibt die Anzeige leer:
        // lieber nichts zeigen als einen Fantasiewert.
        if (raw === null && state.still === false && leg) raw = leg.speed;
        /* Auch der Kurs darf nicht aus zwei benachbarten Fixes kommen: bei
           2–3 m Fahrstrecke je Sekunde und ebenso viel Streuung zeigt die
           Peilung in Zufallsrichtungen. Über das Fenster gemessen stimmt sie. */
        if (course === null && state.still === false && leg) {
          course = bearing(leg.from, leg.to);
        }
        // Strecke nur zählen, wenn die Bewegung deutlich über dem Messrauschen liegt.
        // Distanz und Fahrzeit gehören zur Aufzeichnung – ohne sie würden
        // sie schon beim Liegen im Hafen anwachsen.
        if (recording()) {
          if (segment > Math.max(2, (c.accuracy || 0) * 0.5)) state.distance += segment;
          if (raw !== null && raw > MOVING_MS) state.movingTime += dt;
        }
      }
    }

    if (raw !== null) {
      // Bei erkanntem Stillstand sofort auf null, statt über die Glättung
      // langsam dorthin zu kriechen.
      state.speed = (state.speed === null || state.alpha >= 1 || raw === 0)
        ? raw
        : state.speed + state.alpha * (raw - state.speed);
      if (recording() && state.speed > state.maxSpeed) state.maxSpeed = state.speed;
    }

    const moving = state.still !== true && state.speed !== null && state.speed > MOVING_MS;
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
    el.hint.textContent = moving
      ? ''
      : (state.still === true
          ? 'Stillstand – GPS-Rauschen wird unterdrückt.'
          : (recording() ? 'Kurs erst ab ca. 1 kn Fahrt zuverlässig.'
                         : 'Bereit – „Aufzeichnen“ startet den Törn.'));

    setBadge('live', 'GPS aktiv');
    fetchWeather(false);
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

  /* Die Ortung läuft, solange die App offen ist: Fahrt, Kurs, Karte und
     Wetter sollen ohne Knopfdruck dastehen. Der Knopf unten steuert nur noch
     die Aufzeichnung samt Fahrtdaten. */
  function startWatch() {
    if (state.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      el.hint.textContent = 'Dieses Gerät liefert keine Standortdaten.';
      setBadge('err', 'kein GPS');
      return;
    }
    if (!window.isSecureContext) {
      el.hint.textContent = 'Standort braucht HTTPS (oder localhost).';
      setBadge('err', 'kein GPS');
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    });
    setBadge('wait', 'GPS sucht');
    el.hint.textContent = 'Warte auf Positionsfix …';
  }

  const recording = () => state.startedAt !== null;

  function startSession() {
    if (recording()) return;
    startWatch();                 // falls die Freigabe anfangs abgelehnt wurde
    state.startedAt = Date.now();
    el.startBtn.textContent = 'Stopp';
    el.startBtn.classList.add('running');
    requestWakeLock();
    beginTrip();
  }

  function stopSession() {
    if (!recording()) return;
    state.elapsedBefore = elapsed();
    state.startedAt = null;
    finishTrip();
    el.hint.textContent = 'Aufzeichnung beendet. Ortung läuft weiter.';
    el.startBtn.textContent = 'Aufzeichnen';
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
    state.startedAt = recording() ? Date.now() : null;
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
      refreshWeatherMeta();
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
    if (document.visibilityState !== 'visible') return;
    startWatch();
    if (recording()) requestWakeLock();
  });

  /* ---------- Bedienung ---------- */
  function setUnit(unit) {
    state.unit = UNITS[unit] ? unit : 'kn';
    document.querySelectorAll('.unit').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));
    store.set('unit', state.unit);
    render();
    if (typeof Weather !== 'undefined' && Weather.state) renderWeather();
  }

  document.querySelectorAll('.unit').forEach((b) =>
    b.addEventListener('click', () => setUnit(b.dataset.unit)));

  el.startBtn.addEventListener('click', () => (recording() ? stopSession() : startSession()));
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

  window.addEventListener('online', () => { updateNet(); refreshWeatherMeta(); });
  window.addEventListener('offline', () => { updateNet(); refreshWeatherMeta(); });

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
    // Beim Verlassen des Sparmodus das Wetter nachholen, falls fällig.
    if (!on) fetchWeather(false);
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

  /* ---------- Wetter ---------- */

  /** Zahlen in der Einheit anzeigen, die oben am Tacho gewählt ist. */
  const wxFormat = () => ({
    speed: (ms) => (typeof ms === 'number' && isFinite(ms) ? ms * UNITS[state.unit].factor : null),
    speedLabel: UNITS[state.unit].label,
    speedFloor: state.unit === 'ms' ? 5 : (state.unit === 'kmh' ? 20 : 10)
  });

  const wxReady = () => typeof Weather !== 'undefined' && typeof WeatherView !== 'undefined';

  /**
   * Ausblenden, wenn die Karte nichts Brauchbares zu bieten hat:
   * ohne Daten und ohne Netz, Daten älter als 12 Stunden, oder für einen Ort,
   * der mehr als 100 km entfernt ist. Ohne eigene Position lässt sich die
   * Entfernung nicht beurteilen – dann zählt sie nicht als zu weit.
   */
  function weatherVisible() {
    const data = Weather.state;
    if (!data) return navigator.onLine;
    if (Date.now() - data.fetchedAt > Weather.MAX_AGE_MS) return false;
    if (state.last && haversine(state.last, data) > Weather.MAX_DIST_M) return false;
    return true;
  }

  /** Alter in Minuten und Stunden – Sekunden interessieren beim Wetter nicht. */
  function fmtAge(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 2) return 'gerade eben';
    if (min < 60) return `vor ${min} min`;
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? `vor ${h} h ${rest} min` : `vor ${h} h`;
  }

  /** Ort, Entfernung, Alter und Sichtbarkeit – billig, läuft im Sekundentakt. */
  function refreshWeatherMeta() {
    if (!wxReady()) return;
    el.wxCard.hidden = !weatherVisible();
    const data = Weather.state;
    if (!data) {
      el.wxPlace.textContent = '';
      return;
    }

    const age = Date.now() - data.fetchedAt;
    const ageText = fmtAge(age);
    if (el.wxAge.textContent !== ageText) el.wxAge.textContent = ageText;
    el.wxAge.classList.toggle('old', age > Weather.STALE_MS);

    // Auf offenem Wasser gibt es keinen Ortsnamen – dann steht dort nichts,
    // höchstens die Entfernung zum Ort der Abfrage.
    const name = data.place || '';
    let away = '';
    if (state.last) {
      const d = haversine(state.last, data);
      if (d > 2 * 1852) away = `${(d / 1852).toFixed(d < 18520 ? 1 : 0)} sm entfernt`;
    }
    const label = [name, away].filter(Boolean).join(' · ');
    if (el.wxPlace.dataset.label !== label) {
      el.wxPlace.dataset.label = label;
      el.wxPlace.textContent = name;
      if (away) {
        const small = document.createElement('span');
        small.className = 'su';
        small.textContent = name ? ' · ' + away : away;
        el.wxPlace.appendChild(small);
      }
      el.wxPlace.title = label;
      el.wxPlace.hidden = !label;
    }
  }

  function renderWeather() {
    if (typeof Weather === 'undefined' || typeof WeatherView === 'undefined') return;
    const data = Weather.state;
    // Ohne Daten gibt es nichts umzuschalten und nichts zu zeichnen –
    // Reiter und Diagrammfläche wären nur leerer Platz.
    el.wxNow.hidden = !data;
    el.wxTabs.hidden = !data;
    el.wxChart.hidden = !data;
    refreshWeatherMeta();
    if (!data) {
      el.wxChart.textContent = '';
      el.wxAge.textContent = 'noch nichts geholt';
      if (!el.wxStatus.textContent) {
        el.wxStatus.textContent = navigator.onLine
          ? 'Noch keine Wetterdaten – auf „Aktualisieren“ tippen.'
          : 'Offline – Wetter lässt sich erst mit Internetverbindung holen.';
      }
      return;
    }

    const fmt = wxFormat();
    refreshWeatherMeta();

    const now = data.now;
    const windConverted = fmt.speed(now.wind);
    el.wxWind.textContent = windConverted === null ? '–' : windConverted.toFixed(1);
    el.wxWindUnit.textContent = fmt.speedLabel;
    el.wxGustUnit.textContent = fmt.speedLabel;
    const gustConverted = fmt.speed(now.gust);
    el.wxGust.textContent = gustConverted === null ? '–' : gustConverted.toFixed(1);

    // Beaufort rechnet sich aus Knoten, unabhängig von der Anzeigeeinheit.
    el.wxBft.textContent = typeof now.wind === 'number' && isFinite(now.wind)
      ? Weather.beaufort(now.wind * 1.9438444924406046) + ' Bft' : '';

    if (typeof now.dir === 'number' && isFinite(now.dir)) {
      el.wxDir.textContent = String(Math.round(now.dir) % 360).padStart(3, '0');
      // Meteorologisch zählt die Herkunft – der Pfeil zeigt in die Wehrichtung.
      el.wxDirArrow.firstElementChild.style.transform = `rotate(${(now.dir + 180) % 360}deg)`;
    } else {
      el.wxDir.textContent = '–';
    }

    const waveNow = data.waves && data.waves.now;
    el.wxWave.textContent = waveNow && isFinite(waveNow.wave_height)
      ? Number(waveNow.wave_height).toFixed(1) : '–';
    el.wxTemp.textContent = isFinite(now.temp) ? Math.round(now.temp) : '–';

    const words = Weather.WMO[now.code];
    const rain = isFinite(now.rain) && now.rain > 0 ? `, ${now.rain} ${data.rainUnit}` : '';
    el.wxText.textContent = words ? words + rain : '';

    WeatherView.draw(el.wxChart, data, wxTab, fmt);
  }

  /* Einzelne Ortung nur fürs Wetter – damit die Karte auch ohne laufende
     Aufzeichnung etwas anzeigen kann. */
  function positionForWeather() {
    if (state.last) return Promise.resolve(state.last);
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator) || !window.isSecureContext) {
        reject(new Error('Standort nicht verfügbar (braucht HTTPS).'));
        return;
      }
      // Eigene Reißleine: manche Browser melden eine abgelehnte Freigabe gar
      // nicht zurück, dann bliebe die Anzeige für immer beim Warten stehen.
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      const watchdog = setTimeout(() => finish(reject,
        new Error('Keine Position erhalten – Standortfreigabe prüfen.')), 20000);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(watchdog);
          finish(resolve, { lat: pos.coords.latitude, lon: pos.coords.longitude, t: Date.now() });
        },
        (err) => {
          clearTimeout(watchdog);
          finish(reject, new Error(err.code === 1
            ? 'Standortfreigabe verweigert – ohne Position kein Wetter.'
            : 'Keine Position für die Wetterabfrage erhalten.'));
        },
        { enableHighAccuracy: false, maximumAge: 600000, timeout: 15000 }
      );
    });
  }

  async function fetchWeather(force) {
    // Ohne die Module gibt es nichts zu holen – sonst scheiterte das bei
    // jedem einzelnen Positionsfix erneut.
    if (typeof Weather === 'undefined' || typeof WeatherView === 'undefined') return;
    // Im Sparmodus ist die Wetterkarte ausgeblendet – dann auch nichts holen.
    // Mobilfunk gehört zu den großen Stromfressern.
    if (state.eco) return;
    if (Weather.fetching) return;
    if (!navigator.onLine) {
      el.wxStatus.textContent = Weather.state
        ? 'Offline – angezeigt wird der zuletzt geholte Stand.'
        : 'Offline – Wetter lässt sich erst mit Internetverbindung holen.';
      return;
    }
    // Ohne laufende Ortung nur auf ausdrücklichen Wunsch nach der Position
    // fragen, sonst fiele die Freigabe beim bloßen Öffnen der App an.
    if (!state.last && !force) return;

    let fix;
    try {
      if (!state.last) el.wxStatus.textContent = 'Position wird bestimmt …';
      fix = await positionForWeather();
    } catch (err) {
      el.wxStatus.textContent = err.message;
      return;
    }
    const old = Weather.state;
    if (!force && old) {
      const fresh = Date.now() - old.fetchedAt < Weather.MIN_REFRESH_MS;
      const near = haversine({ lat: old.lat, lon: old.lon }, fix) < Weather.MOVED_REFRESH_M;
      if (fresh && near) return;
    }

    Weather.fetching = true;
    el.wxRefresh.disabled = true;
    el.wxStatus.textContent = 'Wetter wird geholt …';
    try {
      const bundle = await Weather.load(fix.lat, fix.lon);
      Weather.state = bundle;
      Weather.save(bundle);
      el.wxStatus.textContent = bundle.waveNote || '';
      renderWeather();
    } catch (err) {
      // Open-Meteo nennt den Grund im Klartext; genau den zeigen wir. Bricht
      // schon die Verbindung, sagt fetch nur "Failed to fetch" – das übersetzen
      // wir, sonst steht da etwas, mit dem niemand etwas anfangen kann.
      const network = err instanceof TypeError || /failed to fetch|networkerror/i.test(err.message);
      el.wxStatus.textContent = network
        ? 'Wetterdienst nicht erreichbar (Netz, Sperre oder CORS). Später erneut versuchen.'
        : 'Wetter nicht abrufbar: ' + err.message;
    } finally {
      Weather.fetching = false;
      el.wxRefresh.disabled = false;
    }
  }

  el.wxRefresh.addEventListener('click', () => {
    el.wxStatus.textContent = '';
    fetchWeather(true);
  });
  document.querySelectorAll('.wx-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      wxTab = tab.dataset.wx;
      document.querySelectorAll('.wx-tab').forEach((t) =>
        t.setAttribute('aria-pressed', String(t === tab)));
      if (Weather.state) WeatherView.draw(el.wxChart, Weather.state, wxTab, wxFormat());
    });
  });

  /* ---------- App teilen ---------- */

  /* Geteilt wird das Verzeichnis der App, nicht die aufgerufene Datei –
     also ohne "index.html", Suchparameter oder Sprungmarke. */
  const appUrl = () => new URL('.', location.href).href;

  async function shareApp() {
    const url = appUrl();
    const data = {
      title: 'BoatSpeed',
      text: 'Fahrt, Kurs und Wetter fürs Boot – direkt im Browser, auch offline.',
      url
    };
    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;   // Teilen abgebrochen
      }
    }
    // Kein Teilen-Dialog (z. B. Desktop-Browser): in die Zwischenablage.
    try {
      await navigator.clipboard.writeText(url);
      toast('Link zur App kopiert.');
      return;
    } catch (err) { /* keine Berechtigung – dann zum Abschreiben anbieten */ }
    await ask({ title: 'Link zur App', text: 'Zum Weitergeben kopieren:', value: url, okLabel: 'Schließen', noCancel: true });
  }

  $('shareAppBtn').addEventListener('click', shareApp);

  /* ---------- Dialog ---------- */

  /**
   * Eigener Dialog statt prompt()/confirm(): Mit "value" fragt er einen Text
   * ab und liefert ihn zurück, ohne "value" ist er eine Rückfrage und liefert
   * true. Abbruch, Escape und ein Klick neben den Dialog ergeben null.
   */
  function ask({ title, text, value, okLabel, danger, noCancel }) {
    const wantsText = typeof value === 'string';
    $('dlgCancel').hidden = !!noCancel;
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
    } else if (recording() && state.tripId === null) {
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
  // Vor dem Ausrollen steht hier noch der Platzhalter aus dem Quelltext.
  const build = $('buildId');
  if (build && build.textContent.indexOf('BUILD') !== -1) build.textContent = 'lokal, nicht ausgerollt';

  setFollow(true);
  initMap();
  startWatch();   // Position gleich beim Öffnen anfordern
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

  // Fehlt eines der Wetter-Skripte (alter Cache, abgebrochener Upload), darf
  // das nicht den Rest der App lahmlegen – vorher riss der Fehler hier alles
  // Nachfolgende mit, bis hin zum Sekundentakt.
  if (typeof Weather === 'undefined' || typeof WeatherView === 'undefined') {
    el.wxStatus.textContent = 'Wetter-Teil nicht geladen. Bitte die Seite neu laden.';
    el.wxAge.textContent = '–';
  } else {
    Weather.state = Weather.restore();
    renderWeather();
  }

  tick();

  // Nach einem Absturz offen gebliebene Törns schließen, dann Liste zeigen.
  Track.closeDangling().then(renderTrips).catch(() => renderTrips());

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    // Nach einem Deploy übernimmt der neue Service Worker sofort; nur dann,
    // wenn vorher schon einer aktiv war, ist das ein echtes Update.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      // Während einer Aufzeichnung wird nicht ungefragt neu geladen – das
      // würde die laufende Ortung unterbrechen. Sonst übernimmt die App die
      // neue Fassung selbst, damit niemand auf veralteten Dateien sitzen
      // bleibt, ohne es zu merken.
      if (recording()) {
        showUpdateToast();
      } else if (!sessionStorage.getItem('boatspeed.reloaded')) {
        try { sessionStorage.setItem('boatspeed.reloaded', '1'); } catch (err) { /* egal */ }
        location.reload();
      } else {
        showUpdateToast();
      }
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
