<?php
declare(strict_types=1);

/**
 * BoatSpeed – Upload-Proxy für Dawarich.
 *
 * Warum ein Proxy? Dawarich schickt für seine authentifizierte API bewusst
 * keine CORS-Header ("server-to-server"), ein direkter Aufruf aus dem Browser
 * wäre also blockiert. Und der Dawarich-API-Key hätte auf dem Handy ohnehin
 * nichts verloren. Dieses Skript liegt auf derselben Domain wie die App,
 * nimmt den fertigen Track entgegen und reicht ihn serverseitig weiter.
 *
 * Die App weist sich mit einem Gerätetoken im Header X-Device-Token aus.
 * Dass es ein eigener Header sein muss, ist zugleich der Schutz gegen fremde
 * Websites: die dürfen ohne CORS-Freigabe keinen solchen Header senden.
 *
 * Endpunkte:
 *   GET  ?action=ping   Token prüfen und Dawarich anpingen
 *   POST (multipart)    Feld "file" mit .gpx/.geojson – wird importiert
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

$DEFAULTS = [
    'dawarich_url' => '',
    'api_key'      => '',
    'device_token' => '',
    'max_bytes'    => 8 * 1024 * 1024,
    'rate_limit'   => 30,      // Uploads pro Stunde
    'timeout'      => 120,
    'timezone'     => 'Europe/Berlin',
];

$config = $DEFAULTS;
if (is_file(__DIR__ . '/config.php')) {
    $user = require __DIR__ . '/config.php';
    if (is_array($user)) {
        $config = array_merge($DEFAULTS, $user);
    }
}
date_default_timezone_set($config['timezone']);

const ALLOWED_EXT = ['gpx', 'geojson', 'json'];

$DATA_DIR = __DIR__ . '/data';
$RATE_FILE = $DATA_DIR . '/rate.json';
$LOG_FILE  = $DATA_DIR . '/upload.log';

function ensureDataDir(string $dir): void
{
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    $ht = $dir . '/.htaccess';
    if (is_dir($dir) && !is_file($ht)) {
        @file_put_contents($ht, "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
    }
}

function logline(string $message): void
{
    global $LOG_FILE, $DATA_DIR;
    ensureDataDir($DATA_DIR);
    @file_put_contents($LOG_FILE, sprintf("[%s] %s\n", date('Y-m-d H:i:s'), $message), FILE_APPEND | LOCK_EX);
}

function fail(int $status, string $message, array $extra = []): void
{
    http_response_code($status);
    echo json_encode(array_merge(['ok' => false, 'error' => $message], $extra), JSON_UNESCAPED_UNICODE);
    exit;
}

function done(array $payload): void
{
    echo json_encode(array_merge(['ok' => true], $payload), JSON_UNESCAPED_UNICODE);
    exit;
}

/** Gerätetoken prüfen – zeitkonstant, damit sich das Token nicht erraten lässt. */
function authorized(array $config): bool
{
    $want = (string) $config['device_token'];
    if ($want === '') {
        return false;
    }
    $given = (string) ($_SERVER['HTTP_X_DEVICE_TOKEN'] ?? '');
    return $given !== '' && hash_equals($want, $given);
}

/** Einfache Drosselung, damit ein abhandengekommenes Token wenig anrichtet. */
function rateOk(string $file, int $limit): bool
{
    ensureDataDir(dirname($file));
    $now  = time();
    $hits = [];
    if (is_file($file)) {
        $decoded = json_decode((string) file_get_contents($file), true);
        if (is_array($decoded)) {
            $hits = array_values(array_filter($decoded, static fn ($t): bool => is_int($t) && $t > $now - 3600));
        }
    }
    if (count($hits) >= $limit) {
        return false;
    }
    $hits[] = $now;
    @file_put_contents($file, json_encode($hits), LOCK_EX);
    return true;
}

/** Inhalt grob prüfen, damit der Proxy keine beliebigen Dateien weiterreicht. */
function sniffFormat(string $path, string $ext): string
{
    $head = (string) file_get_contents($path, false, null, 0, 4096);
    if ($ext === 'gpx') {
        if (stripos($head, '<gpx') === false) {
            fail(422, 'Die Datei sieht nicht nach GPX aus.');
        }
        return 'gpx';
    }
    $data = json_decode((string) file_get_contents($path), true);
    if (!is_array($data) || (($data['type'] ?? '') !== 'FeatureCollection' && !isset($data['locations']))) {
        fail(422, 'Die Datei ist kein gültiges GeoJSON.');
    }
    return 'geojson';
}

function dawarichUrl(array $config, string $path): string
{
    $base = rtrim((string) $config['dawarich_url'], '/');
    return $base . $path;
}

/**
 * Anfrage an Dawarich. $file != null → Multipart-Upload, sonst GET.
 * Liefert [statuscode, rohtext].
 */
function callDawarich(array $config, string $path, ?array $file = null): array
{
    $url = dawarichUrl($config, $path);
    $sep = strpos($url, '?') === false ? '?' : '&';
    $url .= $sep . 'api_key=' . rawurlencode((string) $config['api_key']);
    $headers = [
        'Authorization: Bearer ' . $config['api_key'],
        'Accept: application/json',
        'User-Agent: BoatSpeed-Uploader',
    ];

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT        => (int) $config['timeout'],
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_FOLLOWLOCATION => false,
        ];
        if ($file !== null) {
            $opts[CURLOPT_POST] = true;
            $opts[CURLOPT_POSTFIELDS] = ['file' => new CURLFile($file['path'], $file['mime'], $file['name'])];
        }
        curl_setopt_array($ch, $opts);
        $body   = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err    = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            fail(502, 'Dawarich ist nicht erreichbar: ' . $err);
        }
        return [$status, (string) $body];
    }

    if (!ini_get('allow_url_fopen')) {
        fail(500, 'Auf dem Server fehlen cURL und allow_url_fopen.');
    }
    $http = ['method' => 'GET', 'timeout' => (int) $config['timeout'], 'ignore_errors' => true];
    if ($file !== null) {
        $boundary = '----boatspeed' . bin2hex(random_bytes(8));
        $body  = "--$boundary\r\n";
        $body .= 'Content-Disposition: form-data; name="file"; filename="' . $file['name'] . "\"\r\n";
        $body .= 'Content-Type: ' . $file['mime'] . "\r\n\r\n";
        $body .= (string) file_get_contents($file['path']) . "\r\n";
        $body .= "--$boundary--\r\n";
        $http['method']  = 'POST';
        $http['content'] = $body;
        $headers[] = 'Content-Type: multipart/form-data; boundary=' . $boundary;
    }
    $http['header'] = implode("\r\n", $headers);
    $response = @file_get_contents($url, false, stream_context_create(['http' => $http]));
    if ($response === false) {
        fail(502, 'Dawarich ist nicht erreichbar.');
    }
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
            $status = (int) $m[1];
        }
    }
    return [$status, (string) $response];
}

// --------------------------------------------------------------------------

if (($config['device_token'] ?? '') === '' || ($config['dawarich_url'] ?? '') === '' || ($config['api_key'] ?? '') === '') {
    fail(503, 'Der Upload ist auf diesem Server nicht eingerichtet (api/config.php fehlt oder ist unvollständig).');
}
// Klartext nur, wenn Dawarich auf demselben Rechner läuft – sonst ginge der
// API-Key ungeschützt über das Netz.
$host = (string) parse_url((string) $config['dawarich_url'], PHP_URL_HOST);
$local = in_array($host, ['localhost', '127.0.0.1', '::1'], true);
if (!preg_match('#^https://#i', (string) $config['dawarich_url']) && !$local) {
    fail(500, 'dawarich_url muss mit https:// beginnen (http nur für localhost).');
}
if (!authorized($config)) {
    fail(403, 'Gerätetoken fehlt oder ist falsch.');
}

$action = (string) ($_GET['action'] ?? '');

if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'ping') {
    [$status, $body] = callDawarich($config, '/api/v1/health');
    done([
        'reachable' => $status >= 200 && $status < 400,
        'status'    => $status,
        'dawarich'  => json_decode($body, true) ?? substr($body, 0, 200),
    ]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail(405, 'Nur GET ?action=ping und POST werden unterstützt.');
}

if (!isset($_FILES['file'])) {
    $hint = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0
        ? 'Vermutlich hat PHP den Upload wegen upload_max_filesize verworfen.'
        : 'Es wurde keine Datei übertragen.';
    fail(400, $hint);
}
$upload = $_FILES['file'];
if ($upload['error'] !== UPLOAD_ERR_OK) {
    $messages = [
        UPLOAD_ERR_INI_SIZE   => 'Die Datei überschreitet upload_max_filesize in der php.ini.',
        UPLOAD_ERR_FORM_SIZE  => 'Die Datei ist zu groß.',
        UPLOAD_ERR_PARTIAL    => 'Der Upload wurde abgebrochen.',
        UPLOAD_ERR_NO_FILE    => 'Es wurde keine Datei übertragen.',
        UPLOAD_ERR_NO_TMP_DIR => 'Auf dem Server fehlt ein temporäres Verzeichnis.',
        UPLOAD_ERR_CANT_WRITE => 'Der Server konnte die Datei nicht zwischenspeichern.',
    ];
    fail(400, $messages[$upload['error']] ?? 'Upload fehlgeschlagen.');
}
if (!is_uploaded_file($upload['tmp_name'])) {
    fail(400, 'Ungültiger Upload.');
}
if ($upload['size'] > (int) $config['max_bytes']) {
    fail(413, sprintf('Die Datei ist größer als %d MB.', (int) ($config['max_bytes'] / 1048576)));
}

$name = preg_replace('/[^A-Za-z0-9._-]/', '-', (string) $upload['name']);
$name = ltrim((string) $name, '.-');
$ext  = strtolower((string) pathinfo($name, PATHINFO_EXTENSION));
if (!in_array($ext, ALLOWED_EXT, true)) {
    fail(422, 'Erlaubt sind nur .gpx, .geojson und .json.');
}
if ($name === '' || strlen($name) > 120) {
    fail(422, 'Ungültiger Dateiname.');
}

$format = sniffFormat($upload['tmp_name'], $ext);

if (!rateOk($RATE_FILE, (int) $config['rate_limit'])) {
    fail(429, 'Zu viele Uploads in der letzten Stunde. Bitte später erneut versuchen.');
}

[$status, $body] = callDawarich($config, '/api/v1/imports', [
    'path' => $upload['tmp_name'],
    'name' => $name,
    'mime' => $format === 'gpx' ? 'application/gpx+xml' : 'application/geo+json',
]);

$parsed = json_decode($body, true);
logline(sprintf('%s (%s, %d Bytes) → HTTP %d', $name, $format, (int) $upload['size'], $status));

if ($status < 200 || $status >= 300) {
    $message = is_array($parsed) ? (string) ($parsed['error'] ?? $parsed['message'] ?? '') : '';
    fail(502, $message !== '' ? 'Dawarich lehnte den Import ab: ' . $message
                              : sprintf('Dawarich antwortete mit HTTP %d.', $status),
        ['status' => $status]);
}

done([
    'import' => is_array($parsed) ? $parsed : null,
    'name'   => is_array($parsed) ? ($parsed['name'] ?? $name) : $name,
    'status' => $status,
]);
