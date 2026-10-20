/* Wetter von Open-Meteo: aktuelle Lage und Kurzfrist für Wind, Welle,
   Niederschlag und Temperatur.

   Kein API-Schlüssel, kein Backend – die App bleibt statisch. Die letzte
   Abfrage liegt im Browser, damit offline wenigstens der letzte Stand
   sichtbar bleibt. Daten unter CC BY 4.0, Quellenhinweis ist Pflicht. */
window.Weather = (() => {
  'use strict';

  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
  const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';

  const HOURS = 24;              // so weit reicht die Grafik
  const MIN_REFRESH_MS = 30 * 60 * 1000;
  const MOVED_REFRESH_M = 25000; // ab 25 km lohnt eine neue Abfrage
  const STALE_MS = 3 * 60 * 60 * 1000;

  /* Windstärken nach Beaufort, obere Grenze je Stufe in Knoten. */
  const BEAUFORT = [1, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63];

  /* Die gebräuchlichsten WMO-Wettercodes. Unbekannte Codes bleiben leer,
     statt etwas Falsches zu behaupten. */
  const WMO = {
    0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt',
    45: 'Nebel', 48: 'Reifnebel',
    51: 'leichter Niesel', 53: 'Niesel', 55: 'starker Niesel',
    56: 'gefrierender Niesel', 57: 'gefrierender Niesel',
    61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen',
    66: 'gefrierender Regen', 67: 'gefrierender Regen',
    71: 'leichter Schnee', 73: 'Schnee', 75: 'starker Schnee', 77: 'Schneegriesel',
    80: 'Regenschauer', 81: 'Regenschauer', 82: 'kräftige Schauer',
    85: 'Schneeschauer', 86: 'Schneeschauer',
    95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Gewitter mit Hagel'
  };

  /* Die API liefert ihre Einheiten mit – daraus wird gerechnet, statt eine
     bestimmte Einheit anzunehmen. */
  const TO_MS = { 'm/s': 1, 'ms': 1, 'km/h': 1 / 3.6, 'kmh': 1 / 3.6, 'kn': 0.5144444, 'kt': 0.5144444, 'knots': 0.5144444, 'mp/h': 0.44704, 'mph': 0.44704 };

  const beaufort = (knots) => {
    for (let i = 0; i < BEAUFORT.length; i++) {
      if (knots <= BEAUFORT[i]) return i;
    }
    return 12;
  };

  let state = null;      // zuletzt geholte und ausgewertete Daten
  let fetching = false;

  /* ---------- Abfrage ---------- */

  async function getJSON(url) {
    const res = await fetch(url, { mode: 'cors' });
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error('Antwort nicht lesbar (HTTP ' + res.status + ').');
    }
    // Open-Meteo meldet Fehler im Rumpf und nennt den Grund – den zeigen
    // wir wörtlich an, sonst sucht man lange.
    if (data && data.error) throw new Error(String(data.reason || 'Abfrage abgelehnt.'));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return data;
  }

  function speedToMs(value, unit) {
    const factor = TO_MS[String(unit || '').toLowerCase()];
    if (!isFinite(value)) return null;
    return factor ? value * factor : value; // unbekannte Einheit: unverändert
  }

  /** Index der Stunde, die am besten zu "jetzt" passt. */
  function currentHourIndex(times) {
    const now = Date.now();
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < times.length; i++) {
      const t = Date.parse(times[i]);
      if (!isFinite(t)) continue;
      const gap = Math.abs(t - now);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return best;
  }

  const slice = (arr, from, count) =>
    Array.isArray(arr) ? arr.slice(from, from + count) : [];

  async function load(lat, lon) {
    const place = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`;
    const common = 'timezone=auto&forecast_days=2';

    const weatherUrl = `${FORECAST_URL}?${place}`
      + '&current=temperature_2m,apparent_temperature,precipitation,weather_code'
      + ',wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl'
      + '&hourly=temperature_2m,precipitation,weather_code'
      + ',wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day'
      + `&wind_speed_unit=ms&${common}`;

    const weather = await getJSON(weatherUrl);

    const times = (weather.hourly && weather.hourly.time) || [];
    const start = currentHourIndex(times);
    const units = weather.hourly_units || {};
    const cur = weather.current || {};
    const curUnits = weather.current_units || {};

    const windMs = (v) => speedToMs(v, units.wind_speed_10m);

    const bundle = {
      fetchedAt: Date.now(),
      lat, lon,
      times: slice(times, start, HOURS),
      wind: slice(weather.hourly.wind_speed_10m, start, HOURS).map(windMs),
      gusts: slice(weather.hourly.wind_gusts_10m, start, HOURS).map((v) => speedToMs(v, units.wind_gusts_10m)),
      dir: slice(weather.hourly.wind_direction_10m, start, HOURS),
      temp: slice(weather.hourly.temperature_2m, start, HOURS),
      rain: slice(weather.hourly.precipitation, start, HOURS),
      isDay: slice(weather.hourly.is_day, start, HOURS),
      tempUnit: units.temperature_2m || '°C',
      rainUnit: units.precipitation || 'mm',
      now: {
        wind: speedToMs(cur.wind_speed_10m, curUnits.wind_speed_10m),
        gust: speedToMs(cur.wind_gusts_10m, curUnits.wind_gusts_10m),
        dir: cur.wind_direction_10m,
        temp: cur.temperature_2m,
        feels: cur.apparent_temperature,
        rain: cur.precipitation,
        pressure: cur.pressure_msl,
        code: cur.weather_code
      },
      waves: null,
      waveNote: null
    };

    // Seegang getrennt holen: fehlt er (Binnengewässer, Randlage der
    // Modelle), bleibt der Rest trotzdem nutzbar.
    try {
      const marine = await getJSON(`${MARINE_URL}?${place}`
        + '&current=wave_height,wave_direction,wave_period'
        + '&hourly=wave_height,wave_direction,wave_period'
        + `&${common}`);
      const mTimes = (marine.hourly && marine.hourly.time) || [];
      const mStart = currentHourIndex(mTimes);
      const heights = slice(marine.hourly.wave_height, mStart, HOURS);
      if (heights.some((v) => typeof v === 'number' && isFinite(v))) {
        bundle.waves = {
          height: heights,
          dir: slice(marine.hourly.wave_direction, mStart, HOURS),
          period: slice(marine.hourly.wave_period, mStart, HOURS),
          unit: (marine.hourly_units && marine.hourly_units.wave_height) || 'm',
          now: marine.current || {}
        };
      } else {
        bundle.waveNote = 'Für diese Position liefert das Seegangsmodell keine Werte.';
      }
    } catch (err) {
      bundle.waveNote = 'Seegang nicht verfügbar: ' + err.message;
    }

    return bundle;
  }

  /* ---------- Zwischenspeicher ---------- */

  function save(bundle) {
    try {
      localStorage.setItem('boatspeed.weather', JSON.stringify(bundle));
    } catch (err) { /* voll oder Privatmodus */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem('boatspeed.weather');
      const data = raw ? JSON.parse(raw) : null;
      if (data && Array.isArray(data.times) && data.times.length) return data;
    } catch (err) { /* beschädigt */ }
    return null;
  }

  return {
    HOURS, WMO, beaufort,
    load, save, restore,
    get state() { return state; },
    set state(v) { state = v; },
    get fetching() { return fetching; },
    set fetching(v) { fetching = v; },
    MIN_REFRESH_MS, MOVED_REFRESH_M, STALE_MS
  };
})();
