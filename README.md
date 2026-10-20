# BoatSpeed

Offlinefähige PWA, die Geschwindigkeit und Kurs über Grund aus dem GPS des Geräts
anzeigt und die Position bei Internetverbindung auf einer OpenStreetMap-Karte darstellt.

Alles ist statisches HTML/CSS/JS – kein Build, kein Backend. Es genügt, den Ordner
über HTTPS auszuliefern (GitHub Pages, Netlify, eigener Webserver …).

## Funktionen

- **Geschwindigkeit** in **m/s**, **km/h** oder **kn**, umschaltbar; die Auswahl wird gespeichert.
- **Kurs über Grund (COG)** in Grad plus Kompassrose und Himmelsrichtung.
- **Fahrtdaten**: Durchschnitt, Maximum, Distanz (sm), Dauer, GPS-Genauigkeit, Höhe.
- **Karte**: OpenStreetMap mit Track und mitdrehendem Bootssymbol; „Folgen“ zentriert
  automatisch. Zuschaltbare **Seezeichen** von OpenSeaMap – Tonnen, Feuer, Häfen.
- **MOB**: ein Druck markiert die Position; danach laufend Peilung, Distanz und
  Alter der Marke, dazu ein Kreuz auf der Karte.
- **Sparmodus**: Karte aus, Anzeige gedrosselt und abgedunkelt – Ortung und
  Aufzeichnung laufen unverändert weiter.
- **Wetter**: aktuelle Lage und 24-Stunden-Verlauf für Wind, Welle, Niederschlag
  und Temperatur, grafisch aufbereitet. Ohne Schlüssel, ohne Backend.
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
| Seezeichen | OpenSeaMap-Kacheln als durchsichtige Ebene über der Grundkarte |
| Offline | Service Worker (`sw.js`): App-Shell vorab, Kacheln „cache first“ |
| Display an | Screen Wake Lock API, sofern vom Browser unterstützt |
| Track-Speicher | IndexedDB (`js/track.js`), gepufferte Schreibvorgänge |
| Export | Web Share API mit Datei, sonst Download über `<a download>` |
| Wetter | Open-Meteo (`js/weather.js`), Diagramme als eigenes SVG ohne Bibliothek |

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

## Mann über Bord

Der rote **MOB**-Knopf in der Fußzeile hält die aktuelle Position fest –
ohne Rückfrage, weil in dieser Lage jede Sekunde zählt. Danach steht oben in
der App eine Karte mit **Peilung**, **Distanz** und **Alter** der Markierung,
die Position in Grad und Dezimalminuten zum Absetzen über Funk, und auf der
Karte ein rotes Kreuz.

Ein erneuter Druck versetzt die Marke auf die jetzige Position. Das Löschen
fragt nach. Die Markierung übersteht Neuladen und Appwechsel; sie bleibt also
auch bestehen, wenn das Handy zwischendurch neu startet.

Ohne Positionsfix lässt sich nichts markieren – dann sagt die App das auch.

## Sparmodus

GPS und Display leeren einen Handyakku in wenigen Stunden. Der Sparmodus
setzt an dem an, was eine Web-App tatsächlich beeinflussen kann:

- **Karte aus.** Keine Kacheln mehr laden, nichts mehr zeichnen. Das spart
  Rechenzeit und unterwegs auch Mobilfunkdaten.
- **Anzeige gedrosselt** auf eine Aktualisierung je Sekunde statt bei jedem Fix.
- **Abgedunkelte Flächen**, was auf OLED-Displays messbar Strom spart.

**Ortung und Aufzeichnung laufen unverändert weiter** – die Genauigkeit wird
nicht heruntergesetzt, es gehen keine Punkte verloren. Beim Zurückschalten ist
der Track vollständig da, er wurde die ganze Zeit mitgeführt.

Was der Sparmodus *nicht* kann: das Display abschalten und im Hintergrund
weiterlaufen. Sobald der Browser die Seite einfriert, steht die Aufzeichnung –
das ist eine Grenze der Plattform, keine Einstellungssache.

## Wetter

Die Wetterkarte holt für die aktuelle Position den Ist-Zustand und einen
24-Stunden-Verlauf von **[Open-Meteo](https://open-meteo.com/)**. Das passt zu
dieser App, weil es **ohne API-Schlüssel** auskommt und CORS erlaubt – es
bleibt also bei einer statischen Seite ohne Geheimnisse.

Oben stehen Wind, Böen, Richtung, Welle und Temperatur auf einen Blick, dazu
die Windstärke in Beaufort. Darunter lässt sich der Verlauf umschalten:

| Reiter | Inhalt |
| --- | --- |
| Wind | Windgeschwindigkeit als Fläche, Böen als gestrichelte Linie, Richtungspfeile, Nachtstunden abgedunkelt |
| Welle | signifikante Wellenhöhe |
| Regen | Niederschlag je Stunde als Balken |
| Temp | Temperaturverlauf |

**Einheiten** folgen der Umschaltung oben am Tacho: Wind erscheint in m/s, km/h
oder Knoten, je nach Auswahl. Beaufort rechnet unabhängig davon immer aus
Knoten. Die App liest die Einheiten aus der Antwort der API und rechnet daraus
um, statt eine bestimmte anzunehmen.

**Wann abgefragt wird:** beim ersten Positionsfix nach dem Öffnen – dafür
muss nichts gedrückt werden –, danach höchstens alle 30 Minuten oder wenn das Boot mehr als 25 km zurückgelegt hat. Der Knopf
*Aktualisieren* erzwingt eine neue Abfrage. Die letzte Antwort bleibt im
Browser gespeichert und wird offline weiter angezeigt, mit Altersangabe.

**Ort und Ausblenden.** Unter der Überschrift steht, für welchen Ort das
Wetter gilt – ermittelt über die Rückwärtssuche von OpenStreetMap
(Nominatim), einmal je Abfrage. Auf offenem Wasser gibt es keinen Ortsnamen,
dann bleibt die Zeile leer. Liegt der Ort der Abfrage mehr als 2 sm entfernt,
wird die Entfernung dazugeschrieben.

Die Wetterkarte verschwindet, wenn sie nichts Brauchbares zeigen kann:

- keine Daten vorhanden und offline,
- die Daten sind älter als 12 Stunden,
- sie gelten für einen Ort, der mehr als 100 km entfernt ist.

Ist das Netz da, holt die App in den beiden letzten Fällen von selbst neue
Daten, und die Karte erscheint wieder. Ohne eigene Position lässt sich die
Entfernung nicht beurteilen; dann bleibt die Karte sichtbar. Jede Abfrage
gibt nach 20 Sekunden auf, damit eine hängende Verbindung keine weiteren
Versuche blockiert.

**Seegang fehlt mancherorts.** Das Wellenmodell deckt nicht jedes Binnen- und
Küstengewässer ab. Dann bleiben Wind, Regen und Temperatur nutzbar und der
Reiter *Welle* sagt, dass für diese Position nichts vorliegt.

Als Modell läuft die Voreinstellung von Open-Meteo, die je nach Region das
jeweils beste wählt – über Europa meist ICON, global GFS. Die Daten stehen
unter CC BY 4.0, der Quellenhinweis unter der Karte gehört deshalb dazu.

## Genauigkeit

- `coords.speed` kommt direkt vom GNSS-Empfänger (Doppler) und ist deutlich genauer
  als die Berechnung aus Positionsdifferenzen; letztere greift nur als Fallback.
- Der Kurs wird erst ab ca. 0,5 m/s (≈ 1 kn) aktualisiert – im Stand ist er reines Rauschen.
  Der zuletzt gültige Kurs bleibt ausgegraut stehen.

### Stillstand

Liegt das Boot still, streuen die Fixes unabhängig voneinander um dieselbe
Lage. Aus dem Abstand zweier aufeinanderfolgender Fixes gerechnet ergibt das
bei 1 s Takt und wenigen Metern Streuung mehrere Knoten in zufälliger
Richtung. **Glätten hilft dagegen grundsätzlich nicht:** Geschwindigkeit ist
ein Betrag, gemitteltes Rauschen bleibt also positiv.

Die App vergleicht deshalb den Versatz zwischen dem ersten und dem letzten Fix
eines Zeitfensters mit der gemeldeten Messgenauigkeit. Im Stand bleibt dieser
Versatz im Rahmen der Unsicherheit, ganz gleich wie lang das Fenster ist –
echte Fahrt wächst dagegen linear mit der Zeit.

Gemessen wird über **drei Fenster zugleich** (5 s, 15 s, 60 s); genommen wird
das kürzeste, dessen Versatz sicher über dem Rauschen liegt. Das folgt aus der
Messtechnik: Bei 6 m Genauigkeit ragt 1 kn erst nach rund einer Minute
heraus, 6 kn schon nach wenigen Sekunden. Ein langes Fenster darf dabei nie
mehr Fahrt melden, als ein kurzes bereits ausgeschlossen hat – sonst hinge die
Anzeige nach dem Anhalten noch eine Minute nach.

Wird Stillstand erkannt, steht die Fahrt auf **0,0**, der Kurs friert
ausgegraut ein, und Distanz wie Fahrzeit wachsen nicht weiter.

**Was das kostet:** Nach dem Losfahren dauert es rund zehn Sekunden, bis eine
Fahrt angezeigt wird, und nach dem Anhalten ebenso lange bis zur Null. Das ist
der Preis dafür, im Hafen keine Phantomfahrt zu sehen.
- Distanzen werden nur addiert, wenn die Bewegung deutlich über der gemeldeten
  Messgenauigkeit liegt; das verhindert „Driften“ beim Ankerliegen.

## Karten-Kacheln

Als Grundkarte dienen die Kacheln von `tile.openstreetmap.org`, die Seezeichen
kommen von `tiles.openseamap.org`. Letztere sind eine **durchsichtige Ebene**:
Sie enthalten nur Symbole und liegen deshalb über der Grundkarte, statt sie zu
ersetzen – allein wären es Tonnen im Nichts. Der Knopf **Seezeichen** an der
Karte schaltet sie zu, die Auswahl wird gespeichert.

Zwischengespeichert wird beides, aber nur das, was tatsächlich angezeigt
wurde – kein Vorab-Download ganzer Reviere, so verlangt es die
[OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/).
Für regelmäßige Nutzung auf See empfiehlt sich ein eigener Tile-Server oder ein
kommerzieller Anbieter; dafür genügt es, die URL in `js/app.js` zu ändern.

## Track aufzeichnen und weitergeben

Die Ortung läuft, sobald die App geöffnet ist – Fahrt, Kurs, Karte und Wetter
stehen also ohne Knopfdruck da. Der Knopf **Aufzeichnen** startet den Törn,
**Stopp** beendet ihn; die Ortung läuft danach weiter. Fahrtdaten wie Distanz
und Dauer gehören zur Aufzeichnung und wachsen deshalb nicht schon beim
Liegen im Hafen. Gespeichert wird
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
