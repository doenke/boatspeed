<?php
/**
 * Vorlage für den Dawarich-Upload. Diese Datei nach "config.php" kopieren.
 * config.php wird nicht ins Repository übernommen und beim Deploy weder
 * überschrieben noch gelöscht.
 *
 * Ohne config.php ist der Upload schlicht aus – die App bietet dann nur
 * Export und Teilen an.
 */
return [
    // Basis-URL deiner Dawarich-Instanz, ohne abschließenden Schrägstrich.
    // Muss https sein: der API-Key geht über diese Verbindung.
    'dawarich_url' => 'https://dawarich.example.org',

    // API-Key aus Dawarich → Profil → Einstellungen.
    'api_key' => '',

    // Frei gewähltes Token, das die App im Header X-Device-Token mitschickt.
    // In der App unter "Dawarich" eintragen. Erzeugen z.B. mit:
    //   php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
    'device_token' => '',

    // Obergrenze für eine hochgeladene Track-Datei.
    'max_bytes' => 8 * 1024 * 1024,

    // Höchstzahl an Uploads pro Stunde.
    'rate_limit' => 30,
];
