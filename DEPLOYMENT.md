# Deployment per SFTP aus GitHub

`.github/workflows/deploy.yml` spiegelt den Stand des `main`-Branches per SFTP
auf den Webspace: neue und geänderte Dateien werden hochgeladen, entfernte auf
dem Server gelöscht. Gearbeitet wird mit `lftp` direkt im Runner – keine
Action aus dem Marketplace, der man Zugangsdaten anvertrauen müsste.

## Secrets anlegen

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
untergeschobenen Server gehen. Ohne dieses Secret bricht der Workflow ab –
das ist Absicht.

Am einfachsten liefert der Workflow die Schlüssel selbst: Actions →
**Deploy per SFTP** → *Run workflow* → **Nur die Hostschlüssel des Servers
ausgeben** anhaken. Im Protokoll stehen dann die Fingerabdrücke zum Abgleich
mit den Angaben des Hosters und darunter die Zeilen, die vollständig in das
Secret gehören. Dafür genügt bereits ein gesetztes `SFTP_HOST`.

Lokal geht es auch mit

```bash
ssh-keyscan -p 2244 ssh.example-hoster.de
```

– aber Vorsicht: ältere `ssh-keyscan`-Versionen, etwa das mit Windows
gelieferte, scheitern an neueren Key-Exchange-Verfahren
(`choose_kex: unsupported KEX method …`) und geben dann **nur Kommentarzeilen
mit `#` aus, keinen einzigen Schlüssel**. Landet so etwas im Secret, meldet
ssh später „Host key verification failed". Der Workflow prüft deshalb vorab,
ob überhaupt eine Schlüsselzeile enthalten ist.

Bei einem abweichenden Port muss die Zeile mit `[host]:port` beginnen – genau
so, wie `ssh-keyscan -p` es ausgibt.

## Erster Lauf

Actions → **Deploy per SFTP** → *Run workflow*, dabei **Nur anzeigen, was
hochgeladen und gelöscht würde** anhaken. Der Trockenlauf verändert nichts und
zeigt im Protokoll, welche Dateien angefasst würden – besonders die Zeilen
`Removing old file`. Erst wenn die Liste plausibel aussieht, ohne Haken
wiederholen.

Danach genügt ein Push auf `main`. Ein manueller Start funktioniert aus jedem
Branch, auch bevor `main` existiert.

## Wichtig zu wissen

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
