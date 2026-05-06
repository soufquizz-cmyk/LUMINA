<?php
/**
 * Shared-hosting proxy for LUMINA / Xtream player (Namecheap, cPanel, etc.).
 * Upload the whole `dist/` folder including this file next to index.html.
 *
 * Override in cPanel → Environment Variables → PROXY_ALLOWED_HOSTS if needed
 * (comma-separated host or host:port). If playlists use segment URLs on another
 * domain, add that hostname to $PROXY_ALLOWED_HOSTS or they will return 403.
 *
 * Build so the app calls this script:
 *   VITE_PROXY_PREFIX=/proxy.php npm run build
 * Or keep default /proxy and use public/.htaccess to rewrite /proxy → proxy.php.
 */
declare(strict_types=1);

/**
 * Default allowlist (only these hosts may be fetched as `target=`).
 * Your Nodecast panel — add more comma-separated entries if playlists use other CDN hosts.
 */
$PROXY_ALLOWED_HOSTS = '5.180.180.198,5.180.180.198:3000';

session_start();

$SCRIPT_PATH = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (!is_string($SCRIPT_PATH) || $SCRIPT_PATH === '' || $SCRIPT_PATH === '/') {
  $SCRIPT_PATH = '/proxy.php';
}

function respond(int $code, string $body, string $type = 'text/plain; charset=utf-8'): void {
  http_response_code($code);
  header('Content-Type: ' . $type);
  echo $body;
  exit;
}

$target = isset($_GET['target']) ? (string) $_GET['target'] : '';
$from = isset($_GET['from']) ? (string) $_GET['from'] : $target;

if ($target === '' || !preg_match('#^https?://#i', $target)) {
  respond(400, 'Bad target');
}

$allowedRaw = getenv('PROXY_ALLOWED_HOSTS');
if ($allowedRaw === false || $allowedRaw === '') {
  $allowedRaw = $GLOBALS['PROXY_ALLOWED_HOSTS'] ?? '';
}
if ($allowedRaw !== '') {
  $pu = parse_url($target);
  $h = isset($pu['host']) ? strtolower((string) $pu['host']) : '';
  $port = isset($pu['port']) ? (int) $pu['port'] : ((isset($pu['scheme']) && strtolower((string) $pu['scheme']) === 'https') ? 443 : 80);
  $hp = $h . ':' . $port;
  $list = array_map('trim', explode(',', (string) $allowedRaw));
  $ok = false;
  foreach ($list as $a) {
    $a = strtolower($a);
    if ($a === $h || $a === $hp) {
      $ok = true;
      break;
    }
  }
  if (!$ok) {
    respond(403, 'Target host not allowed. Set PROXY_ALLOWED_HOSTS or edit proxy.php.');
  }
}

function proxy_jar_get(string $host): string {
  $_SESSION['_pj'] = $_SESSION['_pj'] ?? [];
  $_SESSION['_pj'][$host] = $_SESSION['_pj'][$host] ?? [];
  $pairs = [];
  foreach ($_SESSION['_pj'][$host] as $k => $v) {
    if ($v !== '') {
      $pairs[] = $k . '=' . $v;
    }
  }
  return implode('; ', $pairs);
}

function proxy_jar_set(string $host, string $setCookieLine): void {
  $_SESSION['_pj'] = $_SESSION['_pj'] ?? [];
  $_SESSION['_pj'][$host] = $_SESSION['_pj'][$host] ?? [];
  $part = trim(explode(';', $setCookieLine, 2)[0] ?? '');
  if ($part !== '' && strpos($part, '=') !== false) {
    $eq = strpos($part, '=');
    $n = trim(substr($part, 0, $eq));
    $v = trim(substr($part, $eq + 1));
    if ($n !== '') {
      $_SESSION['_pj'][$host][$n] = $v;
    }
  }
}

function client_authorization(): ?string {
  if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
    return (string) $_SERVER['HTTP_AUTHORIZATION'];
  }
  if (function_exists('apache_request_headers')) {
    foreach (apache_request_headers() as $k => $v) {
      if (strcasecmp((string) $k, 'Authorization') === 0 && is_string($v)) {
        return $v;
      }
    }
  }
  return null;
}

function origin_of(string $url): string {
  $p = parse_url($url);
  if ($p === false) {
    return '';
  }
  $scheme = isset($p['scheme']) && strtolower((string) $p['scheme']) === 'https' ? 'https' : 'http';
  $host = $p['host'] ?? '';
  $port = isset($p['port']) ? ':' . $p['port'] : '';
  return $scheme . '://' . $host . $port;
}

function referer_for_upstream(string $targetUrl, string $fromUrl): string {
  if ($fromUrl !== '' && preg_match('#^https?://#i', $fromUrl)) {
    if (origin_of($targetUrl) !== '' && origin_of($targetUrl) === origin_of($fromUrl)) {
      return $fromUrl;
    }
  }
  $p = parse_url($targetUrl);
  if ($p === false) {
    return $targetUrl;
  }
  $scheme = ($p['scheme'] ?? 'http') === 'https' ? 'https' : 'http';
  $host = $p['host'] ?? '';
  $port = isset($p['port']) ? ':' . $p['port'] : '';
  $path = (string) ($p['path'] ?? '/');
  if ($path === '' || $path === '/') {
    return $scheme . '://' . $host . $port . '/';
  }
  $dir = preg_replace('#/[^/]*$#', '/', $path) ?: '/';
  return $scheme . '://' . $host . $port . $dir;
}

function build_proxy_url(string $absolute, string $fromPlaylist, string $scriptPath): string {
  return $scriptPath . '?' . http_build_query(['target' => $absolute, 'from' => $fromPlaylist]);
}

function rewrite_m3u8(string $body, string $playlistUrl, string $scriptPath): string {
  $base = $playlistUrl;
  $lines = explode("\n", $body);
  $out = [];
  foreach ($lines as $line) {
    $tag = trim($line);
    if (strpos($tag, '#EXT-X-KEY:') === 0 && strpos($tag, 'URI=') !== false) {
      $out[] = preg_replace_callback(
        '/URI="([^"]+)"/',
        function (array $m) use ($base, $scriptPath): string {
          try {
            $resolved = resolve_url($m[1], $base);
            return 'URI="' . build_proxy_url($resolved, $base, $scriptPath) . '"';
          } catch (Throwable $e) {
            return $m[0];
          }
        },
        $line
      );
      continue;
    }
    if (strpos($tag, '#EXT-X-MAP:') === 0 && strpos($tag, 'URI=') !== false) {
      $out[] = preg_replace_callback(
        '/URI="([^"]+)"/',
        function (array $m) use ($base, $scriptPath): string {
          try {
            $resolved = resolve_url($m[1], $base);
            return 'URI="' . build_proxy_url($resolved, $base, $scriptPath) . '"';
          } catch (Throwable $e) {
            return $m[0];
          }
        },
        $line
      );
      continue;
    }
    if ($tag === '' || strpos($tag, '#') === 0) {
      $out[] = $line;
      continue;
    }
    try {
      $resolved = resolve_url($line, $base);
      $out[] = build_proxy_url($resolved, $base, $scriptPath);
    } catch (Throwable $e) {
      $out[] = $line;
    }
  }
  return implode("\n", $out);
}

function resolve_url(string $ref, string $base): string {
  if (preg_match('#^https?://#i', $ref)) {
    return $ref;
  }
  $b = parse_url($base);
  if ($b === false) {
    throw new RuntimeException('bad base');
  }
  $scheme = $b['scheme'] ?? 'http';
  $host = $b['host'] ?? '';
  $port = isset($b['port']) ? ':' . $b['port'] : '';
  $path = $b['path'] ?? '/';
  if (strpos($ref, '//') === 0) {
    return $scheme . ':' . $ref;
  }
  if (strpos($ref, '/') === 0) {
    return $scheme . '://' . $host . $port . $ref;
  }
  $dir = preg_replace('#/[^/]*$#', '/', $path) ?: '/';
  return $scheme . '://' . $host . $port . $dir . $ref;
}

$host = (string) (parse_url($target, PHP_URL_HOST) ?? '');
$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$bodyIn = ($method !== 'GET' && $method !== 'HEAD') ? file_get_contents('php://input') : '';
$looksM3u8 = (bool) preg_match('/\.m3u8(\?|#|$)/i', $target);

$headers = [
  'Accept: ' . (!empty($_SERVER['HTTP_ACCEPT']) ? (string) $_SERVER['HTTP_ACCEPT'] : '*/*'),
  'Accept-Language: en-US,en;q=0.9',
  'User-Agent: VLC/3.0.18 LibVLC/3.0.18',
  'Referer: ' . referer_for_upstream($target, $from),
];
$cj = proxy_jar_get($host);
if ($cj !== '') {
  $headers[] = 'Cookie: ' . $cj;
}
$auth = client_authorization();
if ($auth !== null && $auth !== '') {
  $headers[] = 'Authorization: ' . $auth;
}
$suppressRange = $looksM3u8 || (bool) preg_match('/\.(ts|m4s)(\?|#|$)/i', $target);
if (!empty($_SERVER['HTTP_RANGE']) && !$suppressRange) {
  $headers[] = 'Range: ' . (string) $_SERVER['HTTP_RANGE'];
}
if ($bodyIn !== '' && !empty($_SERVER['CONTENT_TYPE'])) {
  $headers[] = 'Content-Type: ' . (string) $_SERVER['CONTENT_TYPE'];
}

$bufferResponse = $looksM3u8 || $method !== 'GET';

$respHttp = 200;
$respCt = '';
$headerFn = static function ($ch, string $line) use ($host, &$respHttp, &$respCt): int {
  if (preg_match('#\HTTP/\S+\s+(\d+)#', $line, $m)) {
    $respHttp = (int) $m[1];
  }
  $trim = rtrim($line, "\r\n");
  if (preg_match('/^Content-Type:\s*(.+)$/i', $trim, $m)) {
    $respCt = trim(explode(';', $m[1], 2)[0]);
  }
  if (preg_match('/^set-cookie:\s*(.+)$/i', $trim, $m)) {
    proxy_jar_set($host, $m[1]);
  }
  return strlen($line);
};

$ch = curl_init($target);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method === 'HEAD' ? 'HEAD' : $method);
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_MAXREDIRS, 10);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 30);
curl_setopt($ch, CURLOPT_TIMEOUT, $bufferResponse ? 120 : 0);
curl_setopt($ch, CURLOPT_HEADERFUNCTION, $headerFn);
if ($bodyIn !== '' && $method !== 'GET' && $method !== 'HEAD') {
  curl_setopt($ch, CURLOPT_POSTFIELDS, $bodyIn);
}

if ($bufferResponse) {
  curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
  curl_setopt($ch, CURLOPT_HEADER, false);
  $raw = curl_exec($ch);
  if ($raw === false) {
    respond(502, 'curl: ' . curl_error($ch));
  }
  curl_close($ch);

  $code = $respHttp;
  $ct = $respCt;
  $ctMain = strtolower($ct);
  $isM3u8 =
    $looksM3u8
    || strpos($ctMain, 'mpegurl') !== false
    || strpos($ctMain, 'x-mpegurl') !== false
    || strpos(ltrim((string) $raw), '#EXTM3U') === 0;

  if ($isM3u8 && $code >= 200 && $code < 300) {
    $rewritten = rewrite_m3u8((string) $raw, $target, $SCRIPT_PATH);
    http_response_code(200);
    header('Content-Type: application/vnd.apple.mpegurl');
    echo $rewritten;
    exit;
  }

  http_response_code($code);
  if ($ct !== '') {
    header('Content-Type: ' . $ct);
  }
  echo $raw;
  exit;
}

// Stream GET binary (segments, keys) — headers from HEADERFUNCTION, body streamed.
$sent = false;
curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
curl_setopt($ch, CURLOPT_HEADER, false);
curl_setopt(
  $ch,
  CURLOPT_WRITEFUNCTION,
  static function ($ch, string $chunk) use (&$sent, &$respHttp, &$respCt): int {
    if (!$sent) {
      $sent = true;
      http_response_code($respHttp);
      if ($respCt !== '') {
        header('Content-Type: ' . $respCt);
      }
    }
    echo $chunk;
    return strlen($chunk);
  }
);

$ok = curl_exec($ch);
if ($ok === false) {
  if (!$sent) {
    respond(502, 'curl: ' . curl_error($ch));
  }
} elseif (!$sent) {
  // Empty body (e.g. rare edge): still emit status / Content-Type
  http_response_code($respHttp);
  if ($respCt !== '') {
    header('Content-Type: ' . $respCt);
  }
}
curl_close($ch);
