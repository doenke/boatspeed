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
  Teilen-Dialog – von dort z.B. nach Dawarich.

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

### Weitergabe an Dawarich

Der Track verlässt die App ausschließlich über den **Teilen-Knopf** – die App
selbst spricht Dawarich nicht an. Das ist eine bewusste Entscheidung:

- Es liegt **kein Geheimnis auf dem Webspace**. Die App besteht nur aus
  statischen Dateien und darf ohne Bedenken öffentlich liegen.
- Ein Dawarich-API-Key hätte auf einem Handy ohnehin nichts verloren, und ein
  direkter Aufruf wäre technisch gar nicht möglich: Dawarich sendet für seine
  authentifizierte API bewusst keine CORS-Header
  (`config/initializers/cors.rb`: „server-to-server and intentionally NOT
  covered here"), der Browser würde die Anfrage blockieren.

Der Weg auf dem Handy:

1. Beim Törn auf **Teilen** tippen – die App erzeugt ein GeoJSON und öffnet den
   Teilen-Dialog (Dateien, Mail, Cloud …).
2. **Dawarich öffnen** tippen; der Knopf erscheint, sobald unter
   „Dawarich-Adresse" die URL der eigenen Instanz hinterlegt ist. Er führt
   direkt auf `/imports/new`.
3. Dort die eben geteilte Datei auswählen.

Die Adresse ist kein Geheimnis, sie liegt nur lokal im Browser. Am Rechner
heißt der Knopf **GeoJSON** und lädt die Datei herunter statt zu teilen.

**Warum GeoJSON für Dawarich und nicht GPX?** Dawarichs GeoJSON-Import liest
mehr Felder: Geschwindigkeit in m/s unter `speed`, Kurs unter `heading`,
Messgenauigkeit unter `accuracy`. Das GPX ist für alles andere gedacht –
OpenCPN, Garmin, Auswertungswerkzeuge – und trägt Geschwindigkeit und Kurs in
einer `TrackPointExtension`.

## Deployment per SFTP aus GitHub

`.github/workflows/deploy.yml` spiegelt den Stand des `main`-Branches per SFTP
auf den Webspace: neue und geänderte Dateien werden hochgeladen, entfernte auf
dem Server gelöscht. Gearbeitet wird mit `lftp` direkt im Runner – keine
Action aus dem Marketplace, der man Zugangsdaten anvertrauen müsste.

### Secrets anlegen

Repository → Settings → Secrets and variables → Actions:

| Secret | Pflicht | Inhalt |
| --- | --- | --- |
| `SFTP_HOST` | ja | Hostname des Webspace, z.B. `ssh.example-hoster.de` |
| `SFTP_USER` | ja | Benutzername |
| `SFTP_REMOTE_DIR` | ja | Zielverzeichnis, z.B. `/www/boatspeed` |
| `SFTP_KNOWN_HOSTS` | ja | Hostschlüssel des Servers (siehe unten) |
| `SFTP_KEY` | eins von beiden | privater SSH-Schlüssel, komplett inklusive der `-----BEGIN`-Zeile |
| `SFTP_PASSWORD` | eins von beiden | SFTP-Passwort, falls der Hoster keine Schlüssel anbietet |
| `SFTP_PORT` | nein | Standard 22 |

Ist `SFTP_KEY` gesetzt, wird der Schlüssel benutzt, sonst das Passwort.
Schlüssel sind vorzuziehen: sie lassen sich beim Hoster einzeln zurückziehen.

Beim Einfügen mitkopierte Leerzeichen und Zeilenumbrüche in `SFTP_HOST`,
`SFTP_USER`, `SFTP_PORT` und `SFTP_REMOTE_DIR` entfernt der Workflow selbst.
Enthält der Benutzername etwas anderes als Buchstaben, Ziffern und `. _ - @`,
bricht er mit einer verständlichen Meldung ab, statt ssh eine kaputte
Kommandozeile unterzuschieben.

**`SFTP_KNOWN_HOSTS`** verhindert, dass die Zugangsdaten an einen
untergeschobenen Server gehen. Einmalig lokal erzeugen und die Ausgabe
vollständig als Secret einfügen:

```bash
ssh-keyscan -p 22 ssh.example-hoster.de
```

Der Fingerabdruck sollte mit dem übereinstimmen, den der Hoster nennt. Ohne
dieses Secret bricht der Workflow ab – das ist Absicht.

### Erster Lauf

Actions → **Deploy per SFTP** → *Run workflow*, dabei **Nur anzeigen, was
hochgeladen und gelöscht würde** anhaken. Der Trockenlauf verändert nichts und
zeigt im Protokoll, welche Dateien angefasst würden – besonders die Zeilen
`Removing old file`. Erst wenn die Liste plausibel aussieht, ohne Haken
wiederholen.

Danach genügt ein Push auf `main`. Ein manueller Start funktioniert aus jedem
Branch, auch bevor `main` existiert.

### Wichtig zu wissen

- Der Workflow spiegelt **mit Löschen**. Zeigt `SFTP_REMOTE_DIR` versehentlich
  auf ein Verzeichnis mit anderen Inhalten, verschwinden diese. Deshalb ein
  eigenes Unterverzeichnis verwenden; das Wurzelverzeichnis lehnt der Workflow ab.
- `.git`, `.github` und `.gitignore` werden nicht übertragen.
- Der Commit-SHA wird vor dem Upload als Cache-Version in `sw.js` gestempelt
  (Platzhalter `__BUILD__`). Dadurch erkennen installierte Apps das Update,
  verwerfen den alten Cache und melden „Neue Version verfügbar".
- Weil ein frischer Checkout alle Zeitstempel auf „jetzt" setzt, lädt lftp
  jedes Mal alle Dateien neu hoch. Bei rund 250 kB fällt das nicht ins Gewicht.
- Zwei Deploys gleichzeitig verhindert die `concurrency`-Gruppe.

## Lizenzen

Leaflet (BSD-2-Clause) liegt unter `vendor/leaflet/` inklusive `LICENSE`.
Kartendaten © OpenStreetMap-Mitwirkende.
