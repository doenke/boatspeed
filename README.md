# BoatSpeed

Offlinefähige PWA, die Geschwindigkeit und Kurs über Grund aus dem GPS des Geräts
anzeigt und die Position bei Internetverbindung auf einer OpenStreetMap-Karte darstellt.

Alles ist statisches HTML/CSS/JS – kein Build, kein Backend. Es genügt, den Ordner
über HTTPS auszuliefern (GitHub Pages, Netlify, eigener Webserver …).

## Funktionen

- **Geschwindigkeit** in **m/s**, **km/h** oder **kn**, umschaltbar; die Auswahl wird gespeichert.
- **Kurs über Grund (COG)** in Grad plus Kompassrose und Himmelsrichtung.
- **Fahrtdaten**: Durchschnitt, Maximum, Distanz (sm), Dauer, GPS-Genauigkeit, Höhe.
- **Karte**: OpenStreetMap mit Track und mitdrehendem Bootssymbol; „Folgen“ zentriert automatisch.
- **Offline**: App-Shell und Leaflet liegen lokal im Cache, Geschwindigkeit und Kurs
  laufen komplett ohne Netz. Bereits geladene Kartenkacheln bleiben verfügbar.
- **Nachtmodus** (rot), **Display anlassen** (Wake Lock), **Installierbar** als App.
- **Track-Aufzeichnung**: jeder Törn landet in IndexedDB und übersteht Neuladen
  und Appwechsel. Export als **GPX** oder **GeoJSON**, auf dem Handy über den
  Teilen-Dialog. Auf Knopfdruck **Upload zu Dawarich**.

## Technik

| Aufgabe | Umsetzung |
| --- | --- |
| Position, Geschwindigkeit, Kurs | `navigator.geolocation.watchPosition` mit `enableHighAccuracy` |
| Fallback ohne `coords.speed`/`coords.heading` | Berechnung aus zwei Fixes (Haversine bzw. Peilung) |
| Glättung | exponentieller gleitender Mittelwert, dreistufig (aus / leicht / stark) |
| Karte | Leaflet 1.9.4, lokal eingebunden unter `vendor/leaflet/` |
| Offline | Service Worker (`sw.js`): App-Shell vorab, Kacheln „cache first“ |
| Display an | Screen Wake Lock API, sofern vom Browser unterstützt |
| Track-Speicher | IndexedDB (`js/track.js`), gepufferte Schreibvorgänge |
| Dawarich-Upload | PHP-Proxy `api/dawarich.php` → `POST /api/v1/imports` |

Die Sensoren des Handys werden über die Geolocation-API genutzt – das ist die
Quelle, die auf allen Plattformen Geschwindigkeit und Kurs liefert. Kompass- und
Beschleunigungssensoren (`DeviceOrientation`) sind bewusst nicht eingebunden: Sie
liefern die Blickrichtung des Geräts, nicht die Fahrtrichtung des Bootes.

## Nutzung

```bash
# lokal testen
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

Der Standortzugriff funktioniert nur über **HTTPS** oder `localhost`. Auf dem Handy
die Seite öffnen und über das Browsermenü „Zum Startbildschirm hinzufügen“ wählen.

## Genauigkeit

- `coords.speed` kommt direkt vom GNSS-Empfänger (Doppler) und ist deutlich genauer
  als die Berechnung aus Positionsdifferenzen; letztere greift nur als Fallback.
- Der Kurs wird erst ab ca. 0,5 m/s (≈ 1 kn) aktualisiert – im Stand ist er reines Rauschen.
  Der zuletzt gültige Kurs bleibt ausgegraut stehen.
- Distanzen werden nur addiert, wenn die Bewegung deutlich über der gemeldeten
  Messgenauigkeit liegt; das verhindert „Driften“ beim Ankerliegen.

## Karten-Kacheln

Es werden die Kacheln von `tile.openstreetmap.org` verwendet und nur die Kacheln
gespeichert, die tatsächlich angezeigt wurden (kein Vorab-Download ganzer Reviere) –
so verlangt es die [OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/).
Für regelmäßige Nutzung auf See empfiehlt sich ein eigener Tile-Server oder ein
kommerzieller Anbieter; dafür genügt es, die URL in `js/app.js` zu ändern.

## Track aufzeichnen, exportieren, hochladen

Zwischen **Start** und **Stopp** wird ein Törn aufgezeichnet. Gespeichert wird
nicht jeder Fix, sondern gefiltert nach Strecke und Zeit – einstellbar von
„fein" (alle 2 m) bis „sparsam" (alle 25 m), oder ganz aus. Unabhängig davon
sichert die App spätestens alle 30 Sekunden einen Punkt, damit auch eine lange
Flaute im Track auftaucht. Die Punkte gehen gebündelt in IndexedDB; beim
Wegschalten und Schließen wird der Puffer geleert, und ein durch einen Absturz
offen gebliebener Törn wird beim nächsten Start sauber abgeschlossen.

**Zurücksetzen** während der Fahrt schließt den laufenden Törn ab und beginnt
einen neuen – praktisch, um einen Schlag getrennt zu erfassen.

Jeder Törn in der Liste lässt sich umbenennen, als **GPX** oder **GeoJSON**
ausgeben und löschen. Auf dem Handy öffnet der Export den Teilen-Dialog
(AirDrop, Mail, Dateien), sonst lädt die Datei herunter. Das GPX enthält
Zeit, Höhe sowie Geschwindigkeit und Kurs als `TrackPointExtension`.

### Upload zu Dawarich

Warum nicht direkt aus der App? Dawarich schickt für seine authentifizierte API
bewusst keine CORS-Header – im Repository steht dazu ausdrücklich
„server-to-server and intentionally NOT covered here". Ein `fetch` aus dem
Browser würde also blockiert. Und der Dawarich-API-Key hätte auf einem Handy
ohnehin nichts verloren.

Deshalb läuft der Upload über `api/dawarich.php` auf demselben Webspace:

```
App ──(GeoJSON + X-Device-Token)──▶ api/dawarich.php ──(API-Key)──▶ Dawarich
     gleiche Domain, kein CORS                       POST /api/v1/imports
```

Der API-Key bleibt auf dem Server. Auf dem Handy liegt nur ein frei gewähltes
**Gerätetoken**, das sich jederzeit in `api/config.php` austauschen lässt –
danach ist ein verlorenes Handy wertlos. Ein Törn wird zu genau einem Import in
Dawarich, benannt nach Datum und Törnname, dort als Einheit sichtbar und
löschbar.

**Einrichtung:** `api/config.example.php` nach `api/config.php` kopieren,
Dawarich-URL, API-Key (Dawarich → Profil → Einstellungen) und ein selbst
erzeugtes Gerätetoken eintragen. Dasselbe Token in der App unter
„Dawarich-Token" hinterlegen und mit **Verbindung testen** prüfen. Ohne
`api/config.php` antwortet der Endpunkt mit einem klaren Hinweis, und es bleibt
beim Export – die App funktioniert vollständig ohne ihn.

**Was der Proxy prüft:**

- Gerätetoken zeitkonstant (`hash_equals`); ohne Treffer 403.
- Der Token muss im Header `X-Device-Token` stehen. Genau das ist zugleich der
  CSRF-Schutz: eine fremde Website kann diesen Header ohne CORS-Freigabe nicht
  setzen, und der Endpunkt gibt keine CORS-Header aus.
- Nur `.gpx`, `.geojson`, `.json`; Dateiname wird bereinigt, Inhalt wird
  geprüft (GPX muss `<gpx` enthalten, GeoJSON muss als `FeatureCollection`
  parsen). Der Proxy leitet also keine beliebigen Dateien weiter.
- Größenlimit (8 MB) und Drosselung (30 Uploads pro Stunde, in
  `api/data/rate.json`).
- Das Ziel steht ausschließlich in der Serverkonfiguration – kein offener Relay.
- `http://` wird nur für `localhost` akzeptiert; sonst ist `https://` Pflicht,
  damit der API-Key nicht im Klartext über das Netz geht.

Die Geschwindigkeit wird in m/s unter `speed` übergeben, der Kurs als `heading`
– so liest Dawarichs GeoJSON-Import beides ohne Umrechnung ein.

`api/config.php` und `api/data/` sind vom Deploy ausgenommen und per
`.htaccess` gegen Abruf geschützt. Auf nginx greift `.htaccess` nicht: dort
`api/data/` und `api/config.php` in der Serverkonfiguration sperren.

## Deployment auf eigenen Webspace

Unter `deploy/` liegt ein PHP-Skript, das die App direkt von GitHub auf den
Webspace holt – ohne Git, Shell-Zugriff oder Composer. Es lädt den aktuellen
Stand des Branches als ZIP, entpackt ihn und spiegelt ihn ins Zielverzeichnis:
neue und geänderte Dateien werden kopiert, gelöschte entfernt.

### Einrichtung

1. `deploy/deploy.php` und `deploy/config.example.php` auf den Webspace laden,
   z.B. nach `/boatspeed/deploy/`.
2. `config.example.php` zu `config.php` kopieren und ein Token eintragen:
   ```bash
   php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
   ```
3. `https://example.org/boatspeed/deploy/deploy.php?token=DEIN_TOKEN` aufrufen
   und auf **Jetzt aktualisieren** klicken. Fertig – die App liegt danach
   komplett im Verzeichnis darüber.

Für spätere Updates genügt derselbe Aufruf: das Skript vergleicht den
installierten Commit mit GitHub und schreibt nur, was sich geändert hat.
Es aktualisiert dabei auch sich selbst.

### Automatisch statt per Klick

- **Cron** (viele Hoster bieten PHP-Cronjobs an):
  ```
  php /pfad/zum/webspace/boatspeed/deploy/deploy.php --deploy
  ```
- **GitHub-Webhook**: in den Repository-Einstellungen einen Webhook auf
  `https://example.org/boatspeed/deploy/deploy.php` anlegen, Content-Type
  `application/json`, ein Secret vergeben und dasselbe Secret als
  `webhook_secret` in `config.php` eintragen. Jeder Push auf den konfigurierten
  Branch rollt dann automatisch aus.

### Was das Skript beachtet

- Es löscht **nur** Dateien, die ein früherer Deploy selbst angelegt hat
  (protokolliert in `deploy/data/state.json`). Eigene Dateien im selben
  Verzeichnis bleiben unangetastet.
- `deploy/config.php` und `deploy/data/` sind von Schreib- und Löschvorgängen
  ausgenommen; `.htaccess`-Dateien schützen beide vor dem Abruf über den Browser.
  Auf Servern ohne `.htaccess`-Unterstützung (nginx) das Verzeichnis dort selbst
  sperren oder `deploy/` außerhalb des Dokumentenwurzelverzeichnisses ablegen
  und `target` in der Konfiguration setzen.
- Fehlt im heruntergeladenen Archiv eine der Kerndateien, bricht der Deploy ab,
  bevor irgendetwas geschrieben wird.
- Die Cache-Version im Service Worker (`__BUILD__`) wird beim Deploy durch den
  Commit-SHA ersetzt. Dadurch erkennen bereits installierte Apps das Update
  zuverlässig, verwerfen den alten Cache und melden „Neue Version verfügbar“.
- Voraussetzungen: PHP 7.4+ mit `zip` und `curl` (oder `allow_url_fopen`).
  Für private Repositories zusätzlich ein GitHub-Token in `config.php`.

## Lizenzen

Leaflet (BSD-2-Clause) liegt unter `vendor/leaflet/` inklusive `LICENSE`.
Kartendaten © OpenStreetMap-Mitwirkende.
