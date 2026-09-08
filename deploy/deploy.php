<?php
declare(strict_types=1);

/**
 * BoatSpeed – Deployer für klassischen Webspace.
 *
 * Lädt den aktuellen Stand des GitHub-Repositories als ZIP, entpackt ihn in ein
 * temporäres Verzeichnis und spiegelt ihn anschließend in das Zielverzeichnis:
 * neue und geänderte Dateien werden kopiert, entfernte Dateien gelöscht.
 * Gelöscht wird ausschließlich, was ein früherer Deploy selbst angelegt hat
 * (siehe data/state.json) – vorhandene Fremddateien bleiben unangetastet.
 *
 * Benötigt: PHP 7.4+, ZipArchive (oder Phar), cURL (oder allow_url_fopen).
 * Kein Git, kein Shell-Zugriff, kein Composer.
 *
 * Aufruf:
 *   Browser  https://example.org/deploy/deploy.php?token=DEIN_TOKEN
 *   Cron/CLI php deploy/deploy.php --deploy
 *   Webhook  GitHub-Push auf .../deploy/deploy.php (Secret in der Konfiguration)
 */

// --------------------------------------------------------------------------
// Konfiguration
// --------------------------------------------------------------------------

$DEFAULTS = [
    // GitHub-Repository und Branch, der ausgeliefert wird.
    'repo'   => 'doenke/boatspeed',
    'branch' => 'main',

    // Passwort für den Aufruf über den Browser. MUSS gesetzt werden.
    'token' => '',

    // Nur für private Repositories nötig (Personal Access Token, Scope "repo").
    'github_token' => '',

    // Optionales Secret für GitHub-Webhooks (Content-Type application/json).
    'webhook_secret' => '',

    // Zielverzeichnis. Standard: das Verzeichnis über diesem Ordner.
    'target' => null,

    // Diese Pfade (relativ zum Ziel) werden nie geschrieben und nie gelöscht.
    'exclude' => ['deploy/config.php', 'deploy/data'],

    // Diese Pfade aus dem Repository landen gar nicht erst auf dem Webspace.
    'skip' => ['.git', '.github', '.gitignore', '.gitattributes'],

    // Dateien, die im Archiv vorhanden sein müssen – Schutz vor Teil-Downloads.
    'require' => ['index.html', 'manifest.webmanifest', 'sw.js'],

    'timezone' => 'Europe/Berlin',
];

$configFile = __DIR__ . '/config.php';
$config = $DEFAULTS;
if (is_file($configFile)) {
    /** @var array $userConfig */
    $userConfig = require $configFile;
    if (is_array($userConfig)) {
        $config = array_merge($DEFAULTS, $userConfig);
    }
}
if (empty($config['target'])) {
    $config['target'] = dirname(__DIR__);
}
date_default_timezone_set($config['timezone']);

$DATA_DIR   = __DIR__ . '/data';
$STATE_FILE = $DATA_DIR . '/state.json';
$LOG_FILE   = $DATA_DIR . '/deploy.log';

// --------------------------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------------------------

$LOG = [];

/**
 * Legt das Datenverzeichnis an und schützt es gegen direkten Abruf – wichtig,
 * weil deploy/data beim Deploy bewusst ausgespart wird und daher nicht aus dem
 * Repository befüllt werden kann.
 */
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

function logmsg(string $level, string $message): void
{
    global $LOG, $LOG_FILE, $DATA_DIR;
    $LOG[] = ['level' => $level, 'message' => $message];
    ensureDataDir($DATA_DIR);
    @file_put_contents(
        $LOG_FILE,
        sprintf("[%s] %-5s %s\n", date('Y-m-d H:i:s'), strtoupper($level), $message),
        FILE_APPEND | LOCK_EX
    );
}

class DeployError extends RuntimeException
{
}

function isCli(): bool
{
    return PHP_SAPI === 'cli';
}

/**
 * HTTP-GET gegen die GitHub-API. Schreibt bei $sink direkt in eine Datei.
 */
function httpGet(string $url, array $config, ?string $sink = null, array $accept = []): string
{
    $headers = array_merge([
        'User-Agent: BoatSpeed-Deployer',
        'X-GitHub-Api-Version: 2022-11-28',
    ], $accept);
    if (!empty($config['github_token'])) {
        $headers[] = 'Authorization: Bearer ' . $config['github_token'];
    }

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        $fh = null;
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 5,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT        => 180,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        if ($sink !== null) {
            $fh = fopen($sink, 'wb');
            if ($fh === false) {
                throw new DeployError('Temporäre Datei nicht beschreibbar: ' . $sink);
            }
            curl_setopt($ch, CURLOPT_FILE, $fh);
        } else {
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        }
        $body   = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err    = curl_error($ch);
        curl_close($ch);
        if ($fh !== null) {
            fclose($fh);
        }
        if ($body === false && $sink === null) {
            throw new DeployError('cURL-Fehler: ' . $err);
        }
        if ($status < 200 || $status >= 300) {
            throw new DeployError(sprintf('GitHub antwortete mit HTTP %d (%s)', $status, $url));
        }
        return $sink !== null ? '' : (string) $body;
    }

    if (!ini_get('allow_url_fopen')) {
        throw new DeployError('Weder cURL noch allow_url_fopen verfügbar – bitte beim Hoster freischalten lassen.');
    }
    $ctx  = stream_context_create(['http' => [
        'method'        => 'GET',
        'header'        => implode("\r\n", $headers),
        'timeout'       => 180,
        'ignore_errors' => true,
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) {
        throw new DeployError('Download fehlgeschlagen: ' . $url);
    }
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
            $status = (int) $m[1];
        }
    }
    if ($status < 200 || $status >= 300) {
        throw new DeployError(sprintf('GitHub antwortete mit HTTP %d (%s)', $status, $url));
    }
    if ($sink !== null) {
        if (file_put_contents($sink, $body) === false) {
            throw new DeployError('Temporäre Datei nicht beschreibbar: ' . $sink);
        }
        return '';
    }
    return $body;
}

/** Branchnamen dürfen Schrägstriche enthalten – segmentweise kodieren. */
function encodeRef(string $ref): string
{
    return implode('/', array_map('rawurlencode', explode('/', $ref)));
}

function remoteSha(array $config): string
{
    $url = sprintf('https://api.github.com/repos/%s/commits/%s', $config['repo'], encodeRef($config['branch']));
    $sha = trim(httpGet($url, $config, null, ['Accept: application/vnd.github.sha']));
    if (!preg_match('/^[0-9a-f]{40}$/i', $sha)) {
        throw new DeployError('Unerwartete Antwort beim Ermitteln des Commits.');
    }
    return strtolower($sha);
}

function readState(string $file): array
{
    if (!is_file($file)) {
        return ['sha' => null, 'deployed_at' => null, 'files' => []];
    }
    $data = json_decode((string) file_get_contents($file), true);
    return is_array($data) ? $data + ['sha' => null, 'deployed_at' => null, 'files' => []] : ['sha' => null, 'deployed_at' => null, 'files' => []];
}

function writeState(string $file, array $state): void
{
    $dir = dirname($file);
    ensureDataDir($dir);
    if (!is_dir($dir)) {
        throw new DeployError('Verzeichnis nicht anlegbar: ' . $dir);
    }
    if (file_put_contents($file, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX) === false) {
        throw new DeployError('Status konnte nicht gespeichert werden: ' . $file);
    }
}

function rrmdir(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($items as $item) {
        $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
    }
    @rmdir($dir);
}

/** Alle Dateien unterhalb von $dir als relative Pfade mit "/" als Trenner. */
function listFiles(string $dir): array
{
    $out  = [];
    $iter = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );
    foreach ($iter as $file) {
        if ($file->isFile()) {
            $rel   = substr($file->getPathname(), strlen($dir) + 1);
            $out[] = str_replace('\\', '/', $rel);
        }
    }
    sort($out);
    return $out;
}

/** Trifft der Pfad einen Eintrag der Liste (exakt oder als Unterpfad)? */
function pathMatches(string $rel, array $list): bool
{
    foreach ($list as $entry) {
        $entry = trim(str_replace('\\', '/', $entry), '/');
        if ($entry === '') {
            continue;
        }
        if ($rel === $entry || strpos($rel, $entry . '/') === 0) {
            return true;
        }
    }
    return false;
}

function extractArchive(string $archive, string $into): void
{
    if (class_exists('ZipArchive')) {
        $zip = new ZipArchive();
        if ($zip->open($archive) !== true) {
            throw new DeployError('ZIP-Archiv konnte nicht geöffnet werden.');
        }
        if (!$zip->extractTo($into)) {
            $zip->close();
            throw new DeployError('ZIP-Archiv konnte nicht entpackt werden.');
        }
        $zip->close();
        return;
    }
    throw new DeployError('Die PHP-Erweiterung "zip" fehlt – bitte beim Hoster aktivieren lassen.');
}

/** GitHub verpackt alles in einen einzelnen Ordner – dessen Pfad liefern. */
function archiveRoot(string $dir): string
{
    $entries = array_values(array_diff(scandir($dir) ?: [], ['.', '..']));
    if (count($entries) === 1 && is_dir($dir . '/' . $entries[0])) {
        return $dir . '/' . $entries[0];
    }
    return $dir;
}

/**
 * Spiegelt $source nach $target. Liefert Statistik und die neue Dateiliste.
 */
function syncTree(string $source, string $target, array $previous, array $config): array
{
    $files   = listFiles($source);
    $written = [];
    $stats   = ['added' => 0, 'updated' => 0, 'unchanged' => 0, 'deleted' => 0];

    foreach ($files as $rel) {
        if (pathMatches($rel, $config['skip']) || pathMatches($rel, $config['exclude'])) {
            continue;
        }
        $from = $source . '/' . $rel;
        $to   = $target . '/' . $rel;
        $dir  = dirname($to);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new DeployError('Verzeichnis nicht anlegbar: ' . $dir);
        }
        $exists = is_file($to);
        if ($exists && sha1_file($to) === sha1_file($from)) {
            $stats['unchanged']++;
        } else {
            if (!@copy($from, $to)) {
                throw new DeployError('Datei nicht schreibbar: ' . $to);
            }
            @chmod($to, 0644);
            $stats[$exists ? 'updated' : 'added']++;
        }
        $written[] = $rel;
    }

    // Aufräumen: nur Dateien, die ein früherer Deploy selbst angelegt hat.
    $obsolete = array_diff($previous, $written);
    $realTarget = realpath($target);
    foreach ($obsolete as $rel) {
        if (pathMatches($rel, $config['exclude'])) {
            continue;
        }
        $path = $target . '/' . $rel;
        if (!is_file($path)) {
            continue;
        }
        $real = realpath($path);
        if ($real === false || $realTarget === false || strpos($real, $realTarget . DIRECTORY_SEPARATOR) !== 0) {
            continue; // Sicherheitsnetz gegen Pfade außerhalb des Ziels
        }
        if (@unlink($path)) {
            $stats['deleted']++;
            logmsg('info', 'Entfernt: ' . $rel);
        }
    }
    pruneEmptyDirs($target, array_unique(array_map('dirname', $obsolete)), $config);

    sort($written);
    return ['stats' => $stats, 'files' => $written];
}

function pruneEmptyDirs(string $target, array $relDirs, array $config): void
{
    foreach ($relDirs as $rel) {
        $rel = trim(str_replace('\\', '/', $rel), '/');
        while ($rel !== '' && $rel !== '.' && !pathMatches($rel, $config['exclude'])) {
            $dir = $target . '/' . $rel;
            if (!is_dir($dir) || (array_diff(scandir($dir) ?: [], ['.', '..']) !== [])) {
                break;
            }
            @rmdir($dir);
            $rel = trim(dirname($rel), '/');
            if ($rel === '.') {
                break;
            }
        }
    }
}

/**
 * Cache-Version im Service Worker auf den Commit stempeln, damit installierte
 * Clients das Update sicher bemerken und alte Caches verwerfen.
 */
function stampVersion(string $root, string $sha): void
{
    $sw = $root . '/sw.js';
    if (!is_file($sw)) {
        return;
    }
    $code = (string) file_get_contents($sw);
    $new  = str_replace('__BUILD__', substr($sha, 0, 12), $code, $count);
    if ($count > 0) {
        file_put_contents($sw, $new);
    }
}

// --------------------------------------------------------------------------
// Der eigentliche Deploy
// --------------------------------------------------------------------------

function deploy(array $config, string $stateFile, bool $force): array
{
    @set_time_limit(300);

    $target = rtrim((string) $config['target'], '/\\');
    if (!is_dir($target)) {
        throw new DeployError('Zielverzeichnis existiert nicht: ' . $target);
    }
    if (!is_writable($target)) {
        throw new DeployError('Zielverzeichnis ist nicht beschreibbar: ' . $target);
    }

    $state = readState($stateFile);
    $sha   = remoteSha($config);
    logmsg('info', sprintf('Branch %s steht auf %s', $config['branch'], substr($sha, 0, 8)));

    if (!$force && $state['sha'] === $sha) {
        logmsg('info', 'Bereits aktuell – nichts zu tun.');
        return ['changed' => false, 'sha' => $sha, 'stats' => null];
    }

    // Bevorzugt außerhalb des Webroots arbeiten; manche Hoster sperren /tmp.
    $tmp = sys_get_temp_dir() . '/boatspeed-deploy-' . bin2hex(random_bytes(6));
    if (!@mkdir($tmp, 0775, true)) {
        $tmp = $target . '/.boatspeed-deploy-' . bin2hex(random_bytes(6));
        if (!@mkdir($tmp, 0775, true)) {
            throw new DeployError('Temporäres Verzeichnis konnte nicht angelegt werden.');
        }
    }

    try {
        $archive = $tmp . '/source.zip';
        $url     = sprintf('https://api.github.com/repos/%s/zipball/%s', $config['repo'], $sha);
        httpGet($url, $config, $archive);
        $size = (int) @filesize($archive);
        if ($size < 1024) {
            throw new DeployError('Heruntergeladenes Archiv ist unplausibel klein (' . $size . ' Bytes).');
        }
        logmsg('info', sprintf('Archiv geladen (%.1f kB)', $size / 1024));

        $unpacked = $tmp . '/unpacked';
        mkdir($unpacked, 0775, true);
        extractArchive($archive, $unpacked);
        $root = archiveRoot($unpacked);

        foreach ($config['require'] as $needed) {
            if (!is_file($root . '/' . $needed)) {
                throw new DeployError('Im Archiv fehlt "' . $needed . '" – Deploy abgebrochen.');
            }
        }

        stampVersion($root, $sha);
        $result = syncTree($root, $target, (array) $state['files'], $config);

        writeState($stateFile, [
            'sha'         => $sha,
            'short'       => substr($sha, 0, 8),
            'branch'      => $config['branch'],
            'repo'        => $config['repo'],
            'deployed_at' => date('c'),
            'files'       => $result['files'],
        ]);

        $s = $result['stats'];
        logmsg('ok', sprintf(
            'Deploy auf %s abgeschlossen: %d neu, %d aktualisiert, %d unverändert, %d entfernt.',
            substr($sha, 0, 8), $s['added'], $s['updated'], $s['unchanged'], $s['deleted']
        ));

        return ['changed' => true, 'sha' => $sha, 'stats' => $s];
    } finally {
        rrmdir($tmp);
    }
}

// --------------------------------------------------------------------------
// Zugriffsschutz
// --------------------------------------------------------------------------

function tokenOk(array $config): bool
{
    $given = (string) ($_POST['token'] ?? $_GET['token'] ?? '');
    $want  = (string) $config['token'];
    return $want !== '' && hash_equals($want, $given);
}

function webhookOk(array $config, string $body): bool
{
    $secret = (string) $config['webhook_secret'];
    $sig    = (string) ($_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '');
    if ($secret === '' || $sig === '') {
        return false;
    }
    return hash_equals('sha256=' . hash_hmac('sha256', $body, $secret), $sig);
}

// --------------------------------------------------------------------------
// Einstiegspunkte
// --------------------------------------------------------------------------

$state = readState($STATE_FILE);

if (isCli()) {
    $args   = array_slice($argv, 1);
    $force  = in_array('--force', $args, true);
    $doIt   = $force || in_array('--deploy', $args, true);
    if (!$doIt) {
        fwrite(STDOUT, "BoatSpeed Deployer\n");
        fwrite(STDOUT, sprintf("  Repository : %s (%s)\n", $config['repo'], $config['branch']));
        fwrite(STDOUT, sprintf("  Ziel       : %s\n", $config['target']));
        fwrite(STDOUT, sprintf("  Installiert: %s\n", $state['sha'] ? substr($state['sha'], 0, 8) . ' vom ' . $state['deployed_at'] : 'noch nichts'));
        fwrite(STDOUT, "\nAufruf: php deploy.php --deploy [--force]\n");
        exit(0);
    }
    try {
        $result = deploy($config, $STATE_FILE, $force);
        foreach ($LOG as $line) {
            fwrite(STDOUT, sprintf("%-5s %s\n", strtoupper($line['level']), $line['message']));
        }
        exit(0);
    } catch (Throwable $e) {
        logmsg('error', $e->getMessage());
        fwrite(STDERR, 'FEHLER ' . $e->getMessage() . "\n");
        exit(1);
    }
}

// --- Webhook (GitHub push) ---
$rawBody = file_get_contents('php://input') ?: '';
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_SERVER['HTTP_X_GITHUB_EVENT'])) {
    header('Content-Type: application/json; charset=utf-8');
    if (!webhookOk($config, $rawBody)) {
        http_response_code(403);
        echo json_encode(['error' => 'Signatur ungültig']);
        exit;
    }
    if ($_SERVER['HTTP_X_GITHUB_EVENT'] === 'ping') {
        echo json_encode(['ok' => true, 'pong' => true]);
        exit;
    }
    $payload = json_decode($rawBody, true);
    $ref     = is_array($payload) ? (string) ($payload['ref'] ?? '') : '';
    if ($ref !== '' && $ref !== 'refs/heads/' . $config['branch']) {
        echo json_encode(['ok' => true, 'skipped' => $ref]);
        exit;
    }
    try {
        $result = deploy($config, $STATE_FILE, false);
        echo json_encode(['ok' => true] + $result);
    } catch (Throwable $e) {
        logmsg('error', $e->getMessage());
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    }
    exit;
}

// --- Browser ---
if ((string) $config['token'] === '') {
    http_response_code(500);
    echo '<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;padding:2rem">'
       . 'Es ist kein Token gesetzt. Bitte <code>deploy/config.php</code> anlegen '
       . '(Vorlage: <code>config.example.php</code>) und ein Token eintragen.</p>';
    exit;
}
if (!tokenOk($config)) {
    http_response_code(403);
    echo '<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;padding:2rem">Kein Zugriff.</p>';
    exit;
}

$action  = (string) ($_POST['action'] ?? '');
$result  = null;
$error   = null;
$remote  = null;

try {
    if ($action === 'deploy') {
        $result = deploy($config, $STATE_FILE, isset($_POST['force']));
        $state  = readState($STATE_FILE);
        $remote = $result['sha'];
    } else {
        $remote = remoteSha($config);
    }
} catch (Throwable $e) {
    $error = $e->getMessage();
    logmsg('error', $e->getMessage());
}

$upToDate = $remote !== null && $state['sha'] === $remote;
$esc = static fn ($v): string => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
?>
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>BoatSpeed – Deploy</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:24px; background:#0b1622; color:#e8f1f8;
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:720px; margin:0 auto; display:grid; gap:16px; }
  h1 { font-size:1.1rem; letter-spacing:.08em; text-transform:uppercase; color:#8ba3b8; margin:0; }
  .card { background:#14202e; border:1px solid #24384e; border-radius:14px; padding:16px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:0; }
  dt { color:#8ba3b8; }
  dd { margin:0; font-variant-numeric:tabular-nums; word-break:break-all; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:.8rem; border:1px solid currentColor; }
  .ok { color:#4ade80; } .stale { color:#fbbf24; } .bad { color:#f87171; }
  form { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  button { font:inherit; padding:12px 20px; border-radius:12px; border:none; cursor:pointer;
           background:#38bdf8; color:#04121c; font-weight:700; }
  button.ghost { background:transparent; border:1px solid #24384e; color:#8ba3b8; font-weight:400; }
  label.force { color:#8ba3b8; font-size:.85rem; display:flex; gap:6px; align-items:center; }
  ul.log { list-style:none; margin:0; padding:0; font-family:ui-monospace,Menlo,monospace; font-size:.85rem; }
  ul.log li { padding:3px 0; border-bottom:1px solid #1b2b3d; }
  ul.log li:last-child { border-bottom:none; }
  .lvl-ok { color:#4ade80; } .lvl-error { color:#f87171; } .lvl-info { color:#8ba3b8; }
</style>
</head>
<body>
<main>
  <h1>BoatSpeed · Deploy</h1>

  <?php if ($error !== null): ?>
    <div class="card"><strong class="bad">Fehler:</strong> <?= $esc($error) ?></div>
  <?php endif; ?>

  <div class="card">
    <dl>
      <dt>Repository</dt><dd><?= $esc($config['repo']) ?> · <?= $esc($config['branch']) ?></dd>
      <dt>Ziel</dt><dd><code><?= $esc($config['target']) ?></code></dd>
      <dt>Installiert</dt>
      <dd><?= $state['sha'] ? '<code>' . $esc(substr($state['sha'], 0, 8)) . '</code>' : '– noch nichts –' ?>
        <?php if (!empty($state['deployed_at'])): ?>
          <span style="color:#8ba3b8">(<?= $esc(date('d.m.Y H:i', strtotime($state['deployed_at']))) ?>)</span>
        <?php endif; ?>
      </dd>
      <dt>Auf GitHub</dt>
      <dd><?= $remote ? '<code>' . $esc(substr($remote, 0, 8)) . '</code>' : '– unbekannt –' ?></dd>
      <dt>Status</dt>
      <dd>
        <?php if ($remote === null): ?>
          <span class="pill bad">nicht erreichbar</span>
        <?php elseif ($upToDate): ?>
          <span class="pill ok">aktuell</span>
        <?php else: ?>
          <span class="pill stale">Update verfügbar</span>
        <?php endif; ?>
      </dd>
    </dl>
  </div>

  <div class="card">
    <form method="post">
      <input type="hidden" name="token" value="<?= $esc($config['token']) ?>">
      <input type="hidden" name="action" value="deploy">
      <button type="submit"><?= $upToDate ? 'Erneut ausrollen' : 'Jetzt aktualisieren' ?></button>
      <label class="force"><input type="checkbox" name="force" value="1"> alle Dateien neu schreiben</label>
    </form>
  </div>

  <?php if ($LOG): ?>
  <div class="card">
    <ul class="log">
      <?php foreach ($LOG as $line): ?>
        <li class="lvl-<?= $esc($line['level']) ?>"><?= $esc($line['message']) ?></li>
      <?php endforeach; ?>
    </ul>
  </div>
  <?php endif; ?>

  <div class="card" style="color:#8ba3b8;font-size:.85rem">
    Cron-Aufruf: <code>php <?= $esc(__FILE__) ?> --deploy</code><br>
    Nach dem Deploy laden installierte Apps beim nächsten Start automatisch die neue Version.
  </div>
</main>
</body>
</html>
