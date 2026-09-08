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
  und Appwechsel. Benennbar vor dem Start, während der Fahrt und danach; der
  Name steckt im Dateinamen. Export als **GPX** oder **GeoJSON**, auf dem Handy
  über den Teilen-Dialog – von dort z.B. nach Dawarich.

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
| Export | Web Share API mit Datei, sonst Download über `<a download>` |

Die Sensoren des Handys werden über die Geolocation-API genutzt – das ist die
Quelle, die auf allen Plattformen Geschwindigkeit und Kurs liefert. Kompass- und
Beschleunigungssensoren (`DeviceOrientation`) sind bewusst nicht eingebunden: Sie
liefern die Blickrichtung des Geräts, nicht die Fahrtrichtung des Bootes.

## Loslegen

Den Inhalt dieses Verzeichnisses auf einen Webspace kopieren, die Seite auf dem
Handy aufrufen – fertig. Kein Build, kein Backend, keine Abhängigkeiten, die
erst installiert werden müssten.

Zwei Dinge sind zu beachten:

- **HTTPS ist Pflicht.** Ohne verschlüsselte Verbindung rückt der Browser die
  Position nicht heraus. Jedes Zertifikat tut es, auch ein kostenloses.
- **Als App einrichten:** im Browsermenü „Zum Startbildschirm hinzufügen“
  wählen. Dann startet BoatSpeed ohne Adressleiste, läuft offline und darf das
  Display anlassen.

Zum Ausprobieren am Rechner genügt `python3 -m http.server 8000` und
`http://localhost:8000` – localhost gilt dem Browser als sicher genug für den
Standortzugriff.

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

## Track aufzeichnen und weitergeben

Zwischen **Start** und **Stopp** wird ein Törn aufgezeichnet. Gespeichert wird
nicht jeder Fix, sondern gefiltert nach Strecke und Zeit – einstellbar von
„fein" (alle 2 m) bis „sparsam" (alle 25 m), oder ganz aus. Unabhängig davon
sichert die App spätestens alle 30 Sekunden einen Punkt, damit auch eine lange
Flaute im Track auftaucht. Die Punkte gehen gebündelt in IndexedDB; beim
Wegschalten und Schließen wird der Puffer geleert, und ein durch einen Absturz
offen gebliebener Törn wird beim nächsten Start sauber abgeschlossen.

**Zurücksetzen** während der Fahrt schließt den laufenden Törn ab und beginnt
einen neuen – praktisch, um einen Schlag getrennt zu erfassen.

### Törnname

Jeder Törn bekommt beim Start automatisch einen Namen aus `Törn` sowie Datum
und Uhrzeit. Antippen des Namens in der Liste öffnet einen Dialog zum
Umbenennen – während der Fahrt genauso wie danach.

Der Name landet im Dateinamen des Exports und in der Datei selbst, also
zum Beispiel `boatspeed-20260908-1011-Kiel-Marstal.gpx`. Umlaute und
Sonderzeichen werden für den Dateinamen ersetzt, im Track selbst bleiben sie
erhalten.

### Export

Jeder Törn in der Liste lässt sich als **GeoJSON** oder **GPX** ausgeben und
löschen. Auf dem Handy öffnet der erste Knopf den Teilen-Dialog (Dateien,
Mail, Cloud …) und heißt dort **Teilen**; am Rechner lädt er die Datei
herunter und heißt **GeoJSON**.

Beide Formate enthalten Zeit, Position, Höhe, Geschwindigkeit, Kurs und
Messgenauigkeit – im GPX als `TrackPointExtension`, im GeoJSON als
Eigenschaften je Punkt (`speed` in m/s, `heading`, `accuracy`). GPX ist das
universelle Format für OpenCPN, Garmin und Auswertungswerkzeuge; GeoJSON
liest Dawarich beim Import mit den meisten Feldern ein.

### Weitergabe an Dawarich

Der Track verlässt die App ausschließlich über Teilen beziehungsweise
Herunterladen. Dadurch liegt **kein Geheimnis auf dem Webspace** – die App
besteht nur aus statischen Dateien und darf ohne Bedenken öffentlich liegen.

Auf dem Handy:

1. Beim Törn auf **Teilen** tippen und die Datei ablegen.
2. Dawarich öffnen und unter *Imports* die Datei hochladen.

## Deployment

Die App wird per SFTP aus GitHub auf den Webspace gespiegelt – der Workflow
liegt unter `.github/workflows/deploy.yml`. Einrichtung, Secrets und der
Umgang mit Hostschlüsseln stehen in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Lizenz

BoatSpeed steht unter der [MIT-Lizenz](LICENSE).

Mitgeliefert und weiterhin unter ihrer eigenen Lizenz:

- **Leaflet 1.9.4** (BSD-2-Clause) unter `vendor/leaflet/`, samt `LICENSE`.
  Die Bedingungen sind mit MIT verträglich; die Lizenzdatei muss beim
  Weitergeben erhalten bleiben.

Die Kartendaten stammen von OpenStreetMap und stehen unter der
[ODbL](https://www.openstreetmap.org/copyright); der Hinweis
„© OpenStreetMap-Mitwirkende" ist deshalb fest in die Karte eingebaut.
