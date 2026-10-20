/* Darstellung der Wetterdaten: Jetzt-Zeile und eine umschaltbare Grafik
   für Wind, Welle, Niederschlag und Temperatur. Das Diagramm ist handgemaltes
   SVG – für vier schlichte Verläufe lohnt keine Bibliothek, und es erbt so
   die Farben der App einschließlich Nachtmodus. */
window.WeatherView = (() => {
  'use strict';

  const W = 360, H = 150;                       // Zeichenfläche
  const PAD = { top: 22, right: 8, bottom: 18, left: 30 };
  const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };

  const svgEl = (name, attrs) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  };

  const valid = (v) => typeof v === 'number' && isFinite(v);

  /** Hübsche Achsengrenze: 0 … nächster runder Wert über dem Maximum. */
  function niceMax(values, minimum) {
    const peak = Math.max(minimum, ...values.filter(valid));
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const magnitude = Math.pow(10, Math.floor(Math.log10(peak || 1)));
    for (const s of steps) {
      const candidate = s * magnitude;
      if (candidate >= peak) return candidate;
    }
    return 10 * magnitude;
  }

  const hourLabel = (iso) => {
    const d = new Date(iso);
    return isFinite(d.getTime()) ? String(d.getHours()).padStart(2, '0') : '';
  };

  /**
   * Zeichnet eine Reihe. series = { values, max, kind, color, label }
   * kind: 'area' (Wind, Welle, Temperatur) oder 'bars' (Niederschlag).
   */
  function draw(container, data, which, format) {
    container.textContent = '';
    const series = pick(data, which, format);
    if (!series || !series.values.some(valid)) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = series && series.missing
        ? series.missing
        : 'Für diesen Wert liegen keine Daten vor.';
      container.appendChild(note);
      return;
    }

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      class: 'wx-chart',
      role: 'img',
      'aria-label': series.label
    });

    const n = series.values.length;
    const x = (i) => PAD.left + (n === 1 ? PLOT.w / 2 : (i / (n - 1)) * PLOT.w);
    const top = series.max;
    const base = series.min || 0;
    const y = (v) => PAD.top + PLOT.h - ((v - base) / (top - base || 1)) * PLOT.h;

    // Nacht hinterlegen, damit die Zeitachse ohne Datum lesbar bleibt.
    if (Array.isArray(data.isDay)) {
      let from = null;
      for (let i = 0; i <= n; i++) {
        const night = i < n && data.isDay[i] === 0;
        if (night && from === null) from = i;
        if (!night && from !== null) {
          svg.appendChild(svgEl('rect', {
            x: x(from), y: PAD.top, width: Math.max(1, x(i - 1) - x(from)),
            height: PLOT.h, class: 'wx-night'
          }));
          from = null;
        }
      }
    }

    // Gitter und Beschriftung der Werteachse
    for (let g = 0; g <= 2; g++) {
      const value = base + ((top - base) / 2) * g;
      svg.appendChild(svgEl('line', {
        x1: PAD.left, x2: W - PAD.right, y1: y(value), y2: y(value), class: 'wx-gridline'
      }));
      const label = svgEl('text', { x: PAD.left - 5, y: y(value) + 3.5, class: 'wx-axis' });
      label.textContent = Math.abs(top - base) < 6 ? value.toFixed(1) : String(Math.round(value));
      svg.appendChild(label);
    }

    if (series.kind === 'bars') {
      const width = Math.max(2, PLOT.w / n - 2);
      series.values.forEach((v, i) => {
        if (!valid(v) || v <= 0) return;
        svg.appendChild(svgEl('rect', {
          x: x(i) - width / 2, y: y(v), width, height: Math.max(1, y(base) - y(v)),
          class: 'wx-bar'
        }));
      });
    } else {
      const points = series.values.map((v, i) => (valid(v) ? `${x(i)},${y(v)}` : null)).filter(Boolean);
      svg.appendChild(svgEl('polygon', {
        points: `${PAD.left},${y(base)} ${points.join(' ')} ${W - PAD.right},${y(base)}`,
        class: 'wx-area'
      }));
      svg.appendChild(svgEl('polyline', { points: points.join(' '), class: 'wx-line' }));
    }

    // Böen als zweite, gestrichelte Linie
    if (series.second) {
      const pts = series.second.map((v, i) => (valid(v) ? `${x(i)},${y(v)}` : null)).filter(Boolean);
      svg.appendChild(svgEl('polyline', { points: pts.join(' '), class: 'wx-second' }));
    }

    // Richtungspfeile: Windrichtung ist meteorologisch die Herkunft, der
    // Pfeil zeigt also dorthin, wohin es weht.
    if (series.dir) {
      for (let i = 0; i < n; i += 3) {
        const d = series.dir[i];
        if (!valid(d)) continue;
        const arrow = svgEl('path', {
          d: 'M0,-5 L3,3 L0,1 L-3,3 Z',
          class: 'wx-arrow',
          transform: `translate(${x(i)}, ${PAD.top - 11}) rotate(${(d + 180) % 360})`
        });
        svg.appendChild(arrow);
      }
    }

    // Stundenbeschriftung
    for (let i = 0; i < n; i += 6) {
      const label = svgEl('text', { x: x(i), y: H - 5, class: 'wx-axis wx-axis-x' });
      label.textContent = hourLabel(data.times[i]);
      svg.appendChild(label);
    }

    container.appendChild(svg);

    const legend = document.createElement('div');
    legend.className = 'wx-legend';
    legend.textContent = series.label;
    container.appendChild(legend);
  }

  /** Wählt die anzuzeigende Reihe und bringt sie in die Anzeigeeinheit. */
  function pick(data, which, format) {
    if (which === 'wind') {
      const values = data.wind.map(format.speed);
      const gusts = data.gusts.map(format.speed);
      const max = niceMax(values.concat(gusts), format.speedFloor);
      return {
        values, second: gusts, dir: data.dir, kind: 'area', max, min: 0,
        label: `Wind und Böen in ${format.speedLabel}`
      };
    }
    if (which === 'wave') {
      if (!data.waves) return { values: [], missing: data.waveNote };
      const values = data.waves.height;
      return {
        values, dir: data.waves.dir, kind: 'area',
        max: niceMax(values, 1), min: 0,
        label: `Signifikante Wellenhöhe in ${data.waves.unit}`
      };
    }
    if (which === 'rain') {
      const values = data.rain;
      return {
        values, kind: 'bars', max: niceMax(values, 1), min: 0,
        label: `Niederschlag in ${data.rainUnit} je Stunde`
      };
    }
    const values = data.temp;
    const nums = values.filter(valid);
    const lo = Math.floor(Math.min(...nums) - 1);
    const hi = Math.ceil(Math.max(...nums) + 1);
    return {
      values, kind: 'area', max: hi, min: lo,
      label: `Temperatur in ${data.tempUnit}`
    };
  }

  return { draw };
})();
