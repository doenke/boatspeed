<?php
/**
 * Vorlage für die Deployer-Konfiguration.
 *
 * Diese Datei nach "config.php" kopieren und anpassen. config.php wird nicht
 * ins Repository übernommen und beim Deploy weder überschrieben noch gelöscht.
 */
return [
    // Repository und Branch, der ausgeliefert werden soll.
    'repo'   => 'doenke/boatspeed',
    'branch' => 'main',

    // Passwort für den Aufruf im Browser – bitte lang und zufällig wählen, z.B.
    //   php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
    'token' => 'HIER-EIN-LANGES-ZUFALLSTOKEN-EINTRAGEN',

    // Nur für private Repositories: Personal Access Token mit Scope "repo".
    'github_token' => '',

    // Optional: Secret für GitHub-Webhooks (Settings → Webhooks → Secret),
    // damit ein Push automatisch deployt. Content-Type: application/json.
    'webhook_secret' => '',

    // Zielverzeichnis. null = das Verzeichnis oberhalb von deploy/.
    // Beispiel für ein Unterverzeichnis: '/var/www/example.org/boatspeed'
    'target' => null,

    // Pfade (relativ zum Ziel), die der Deployer nie anfasst.
    'exclude' => ['deploy/config.php', 'deploy/data', 'api/config.php', 'api/data'],
];
