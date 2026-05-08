/**
 * Vercel serverless equivalent of the Vite `/proxy` middleware.
 * Without this, production builds hit `/proxy` on static hosting and Nodecast login fails.
 *
 * Media segments (.ts, etc.) are streamed (not fully buffered) so playback starts quickly
 * and memory/billing stay reasonable.
 */
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fromBase64UrlUtf8, proxiedFullUrl } from "./proxyParamTransport.js";

const PROXY_PREFIX = (process.env.VITE_PROXY_PREFIX ?? "/proxy").replace(/\/$/, "");

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

const cookieByHost = new Map<string, Record<string, string>>();
const lastM3u8ByHlsDir = new Map<string, string>();

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function stripDefaultPortHref(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && u.port === "80") u.port = "";
    if (u.protocol === "https:" && u.port === "443") u.port = "";
    return u.href;
  } catch {
    return url;
  }
}

function refererForTarget(targetUrl: string): string {
  const u = new URL(targetUrl);
  if (!u.pathname || u.pathname === "/") {
    return stripDefaultPortHref(`${u.origin}/`);
  }
  const dir = u.pathname.replace(/\/[^/]*$/, "/") || "/";
  return stripDefaultPortHref(`${u.origin}${dir}`);
}

function hlsTokenDirKey(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^(\/hls\/[^/]+)\//i);
    if (!m) return null;
    return stripDefaultPortHref(`${u.origin}${m[1]}/`);
  } catch {
    return null;
  }
}

function parseSetCookieNameValue(line: string): [string, string] | null {
  const first = line.split(";")[0]?.trim();
  if (!first?.includes("=")) return null;
  const i = first.indexOf("=");
  const name = first.slice(0, i).trim();
  const value = first.slice(i + 1).trim();
  if (!name) return null;
  return [name, value];
}

function ingestUpstreamSetCookies(upstream: Response, requestUrl: string): void {
  const host = new URL(requestUrl).host;
  const h = upstream.headers as Headers & { getSetCookie?: () => string[] };
  const lines =
    typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
  const fallback = upstream.headers.get("set-cookie");
  const allLines =
    lines.length > 0 ? lines : fallback ? [fallback] : [];
  if (!allLines.length) return;
  let jar = cookieByHost.get(host);
  if (!jar) {
    jar = Object.create(null) as Record<string, string>;
    cookieByHost.set(host, jar);
  }
  for (const line of allLines) {
    const p = parseSetCookieNameValue(line);
    if (p) jar[p[0]] = p[1];
  }
}

function cookieHeaderForUpstreamUrl(requestUrl: string): string | undefined {
  const host = new URL(requestUrl).host;
  const jar = cookieByHost.get(host);
  if (!jar) return undefined;
  const pairs = Object.entries(jar).filter(([, v]) => v !== "");
  if (!pairs.length) return undefined;
  return pairs.map(([k, v]) => `${k}=${v}`).join("; ");
}

function getHeader(req: VercelRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

function buildUpstreamHeaders(
  req: VercelRequest,
  targetUrl: string,
  fromPlaylist: string | null
): Record<string, string> {
  const target = new URL(targetUrl);
  const targetPath = target.pathname;
  const targetUnderHls = /^\/hls\//i.test(targetPath);
  const targetIsTsUnderHls = targetUnderHls && /\.ts$/i.test(targetPath);

  let referer = refererForTarget(targetUrl);
  if (fromPlaylist && isHttpUrl(fromPlaylist)) {
    try {
      const from = new URL(fromPlaylist);
      if (from.origin === target.origin) {
        if (targetIsTsUnderHls) {
          referer = refererForTarget(targetUrl);
        } else if (/\/live\//i.test(from.pathname) && targetUnderHls) {
          referer = refererForTarget(targetUrl);
        } else if (/\/live\/.+\.m3u8$/i.test(targetPath)) {
          referer = stripDefaultPortHref(`${target.origin}/`);
        } else if (
          /\/get_vod_info$/i.test(targetPath) ||
          /\/get_series_info$/i.test(targetPath) ||
          /\/player_api(\.php)?$/i.test(targetPath)
        ) {
          referer = stripDefaultPortHref(`${target.origin}/`);
        } else {
          referer = stripDefaultPortHref(from.href);
        }
      }
    } catch {
      /* ignore */
    }
  }
  const acceptStr = getHeader(req, "accept") || "*/*";
  const origin = stripDefaultPortHref(target.origin);
  referer = stripDefaultPortHref(referer);
  if (targetUnderHls && !/\.m3u8$/i.test(targetPath) && !targetIsTsUnderHls) {
    const dirKey = hlsTokenDirKey(targetUrl);
    const lastM3u8 = dirKey ? lastM3u8ByHlsDir.get(dirKey) : undefined;
    if (lastM3u8) referer = stripDefaultPortHref(lastM3u8);
  }
  const isXtreamInfoEndpoint =
    /\/get_vod_info$/i.test(targetPath) ||
    /\/get_series_info$/i.test(targetPath) ||
    /\/player_api(\.php)?$/i.test(targetPath);
  const h: Record<string, string> = {
    Accept: isXtreamInfoEndpoint
      ? "application/json, text/plain;q=0.9, */*;q=0.8"
      : acceptStr,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer,
    "User-Agent": "VLC/3.0.18 LibVLC/3.0.18",
  };
  const cookie = cookieHeaderForUpstreamUrl(targetUrl);
  if (cookie) h.Cookie = cookie;
  if (!targetUnderHls || /\.m3u8$/i.test(targetPath) || targetIsTsUnderHls) {
    h.Origin = origin;
  }
  const range = getHeader(req, "range");
  if (range?.trim()) h.Range = range;
  const ifRange = getHeader(req, "if-range");
  if (ifRange?.trim()) h["If-Range"] = ifRange;
  const acceptEncoding = getHeader(req, "accept-encoding");
  if (acceptEncoding?.trim()) h["Accept-Encoding"] = acceptEncoding;
  const authorization = getHeader(req, "authorization");
  if (authorization?.trim()) h.Authorization = authorization;
  const ifNoneMatch = getHeader(req, "if-none-match");
  if (ifNoneMatch?.trim()) h["If-None-Match"] = ifNoneMatch;
  const ifModifiedSince = getHeader(req, "if-modified-since");
  if (ifModifiedSince?.trim()) h["If-Modified-Since"] = ifModifiedSince;
  return h;
}

function rewriteM3u8(body: string, playlistUrl: string): string {
  const base = new URL(playlistUrl);
  const proxy = (absolute: string) => proxiedFullUrl(PROXY_PREFIX, absolute, playlistUrl);
  return body
    .split("\n")
    .map((line) => {
      const tag = line.trim();
      if (tag.startsWith("#EXT-X-KEY:") && tag.includes("URI=")) {
        return line.replace(/URI="([^"]+)"/, (_m, uri: string) => {
          try {
            const resolved = new URL(uri, base).href;
            return `URI="${proxy(resolved)}"`;
          } catch {
            return line;
          }
        });
      }
      if (tag.startsWith("#EXT-X-MAP:") && tag.includes("URI=")) {
        return line.replace(/URI="([^"]+)"/, (_m, uri: string) => {
          try {
            const resolved = new URL(uri, base).href;
            return `URI="${proxy(resolved)}"`;
          } catch {
            return line;
          }
        });
      }
      if (!tag || tag.startsWith("#")) return line;
      try {
        const resolved = new URL(tag, base).href;
        return proxy(resolved);
      } catch {
        return line;
      }
    })
    .join("\n");
}

function readBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Do not forward to client; cookies stay in server-side jar like Vite. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "set-cookie",
]);

function copyUpstreamHeadersToRes(upstream: Response, res: VercelResponse): void {
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    try {
      res.setHeader(key, value);
    } catch {
      /* ignore invalid header names */
    }
  });
}

function isLikelyLivePlaylist(body: string): boolean {
  return (
    /#EXT-X-TARGETDURATION:/i.test(body) ||
    /#EXT-X-MEDIA-SEQUENCE:/i.test(body) ||
    /#EXT-X-PLAYLIST-TYPE:\s*EVENT/i.test(body)
  );
}

function isPlaylistPath(pathname: string): boolean {
  return /\.m3u8$/i.test(pathname);
}

function isMediaBinaryPath(pathname: string): boolean {
  return /\.(ts|m4s|mp4|m4v|mkv|aac|mp3|webm|vtt|webvtt|m3u8\.ts)$/i.test(pathname) ||
    /\/segment\//i.test(pathname);
}

function applyMediaCachingHeaders(
  res: VercelResponse,
  upstream: Response,
  targetUrl: string
): void {
  const pathname = new URL(targetUrl).pathname;
  if (isPlaylistPath(pathname)) return;
  if (!isMediaBinaryPath(pathname)) return;
  const cacheControl = upstream.headers.get("cache-control");
  if (!cacheControl?.trim()) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
}

function isAllowedTarget(target: string): boolean {
  const raw = process.env.PROXY_ALLOWED_HOSTS?.trim();
  if (!raw) return true;
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  const hostPort = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const allowed = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = u.hostname.toLowerCase();
  const hp = hostPort.toLowerCase();
  return allowed.some((a) => a === h || a === hp || a === `${h}:${u.port}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/api/proxy", `http://${host}`);
  const qb64 = url.searchParams.get("targetB64");
  const fb64 = url.searchParams.get("fromB64");
  let target = url.searchParams.get("target");
  let from = url.searchParams.get("from");
  if (qb64) {
    try {
      target = fromBase64UrlUtf8(qb64);
    } catch {
      res.status(400).send("Bad targetB64");
      return;
    }
  }
  if (fb64) {
    try {
      from = fromBase64UrlUtf8(fb64);
    } catch {
      res.status(400).send("Bad fromB64");
      return;
    }
  }
  if (!from && target) from = target;

  if (!target || !isHttpUrl(target)) {
    res.status(400).send("Bad target");
    return;
  }

  if (!isAllowedTarget(target)) {
    let blockedHost = "(invalid)";
    try {
      const u = new URL(target);
      blockedHost = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
      // keep fallback
    }
    const allowedRaw = process.env.PROXY_ALLOWED_HOSTS?.trim();
    const allowedList = allowedRaw
      ? allowedRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const requestId = getHeader(req, "x-vercel-id") ?? "unknown";
    console.warn("[proxy] blocked target host", {
      requestId,
      blockedHost,
      target,
      allowedHosts: allowedList,
    });
    res
      .status(403)
      .send(
        `Proxy target host not allowed. blockedHost=${blockedHost}; allowedHosts=${
          allowedList.length ? allowedList.join(",") : "(none configured)"
        }. Set PROXY_ALLOWED_HOSTS on Vercel (comma-separated host or host:port).`
      );
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();
  const outHeaders = buildUpstreamHeaders(req, target, from);

  let requestBody: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const buf = await readBody(req);
    requestBody = buf.length > 0 ? buf : undefined;
    const contentType = getHeader(req, "content-type");
    if (contentType && requestBody) {
      outHeaders["Content-Type"] = contentType;
      outHeaders["Content-Length"] = String(requestBody.length);
    }
  }

  const ac = new AbortController();
  const defaultUpstreamMs = 60_000;
  const targetPath = new URL(target).pathname;
  const isPlaylistRequest = /\.m3u8$/i.test(targetPath);
  const isMediaSegmentRequest =
    /\.(ts|m4s|mp4|m4v|aac|mp3|webm|mkv)$/i.test(targetPath) ||
    /\/segment\//i.test(targetPath);
  const transcodeCapRaw = Number(process.env.XTREAM_PROXY_TRANSCODE_SESSION_MS);
  const transcodeSessionCapMs = Number.isFinite(transcodeCapRaw)
    ? Math.min(Math.max(transcodeCapRaw, 3_000), 120_000)
    : 20_000;
  const streamProbeCapRaw = Number(process.env.XTREAM_PROXY_STREAM_PROBE_MS);
  const streamProbeCapMs = Number.isFinite(streamProbeCapRaw)
    ? Math.min(Math.max(streamProbeCapRaw, 3_000), 120_000)
    : 18_000;
  let abortMs = defaultUpstreamMs;
  if (isMediaSegmentRequest) {
    abortMs = 180_000;
  } else if (isPlaylistRequest) {
    abortMs = 45_000;
  }
  if (method === "POST" && /\/api\/transcode\/session(?:\?|$)/i.test(target)) {
    abortMs = Math.min(defaultUpstreamMs, transcodeSessionCapMs);
  } else if (
    method === "GET" &&
    /\/api\/proxy\/stream(?:\?|$)/i.test(target) &&
    getHeader(req, "x-playable-probe") === "1"
  ) {
    abortMs = Math.min(defaultUpstreamMs, streamProbeCapMs);
  }
  const t = setTimeout(() => ac.abort(), abortMs);
  try {
    const upstream = await fetch(target, {
      signal: ac.signal,
      method,
      headers: outHeaders,
      body:
        requestBody && method !== "GET" && method !== "HEAD"
          ? new Uint8Array(requestBody)
          : undefined,
    });
    ingestUpstreamSetCookies(upstream, target);
    const ct =
      upstream.headers.get("content-type")?.split(";")[0]?.trim() ?? "";

    const isM3u8Rewrite =
      upstream.ok &&
      (ct === "application/vnd.apple.mpegurl" ||
        ct === "application/x-mpegURL" ||
        target.toLowerCase().includes(".m3u8"));

    if (isM3u8Rewrite) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      const dirKey = hlsTokenDirKey(target);
      if (dirKey) lastM3u8ByHlsDir.set(dirKey, stripDefaultPortHref(target));
      const text = buf.toString("utf8");
      const rewritten = rewriteM3u8(text, target);
      res.status(upstream.status);
      copyUpstreamHeadersToRes(upstream, res);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.removeHeader("Content-Length");
      if (!upstream.headers.get("cache-control") && isLikelyLivePlaylist(text)) {
        // Live playlists should revalidate frequently; do not force no-store on segments.
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
      res.send(Buffer.from(rewritten, "utf8"));
      return;
    }

    /* Segments and binary: stream so the player receives bytes immediately (no full-buffer). */
    res.status(upstream.status);
    if (
      upstream.status === 204 ||
      upstream.status === 304 ||
      method === "HEAD" ||
      !upstream.body
    ) {
      copyUpstreamHeadersToRes(upstream, res);
      applyMediaCachingHeaders(res, upstream, target);
      res.end();
      return;
    }

    res.once("close", () => {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    });

    copyUpstreamHeadersToRes(upstream, res);
    if (!res.getHeader("Content-Type") && ct) res.setHeader("Content-Type", ct);
    if (!res.getHeader("Accept-Ranges")) {
      const acceptRanges = upstream.headers.get("accept-ranges");
      if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
    }
    applyMediaCachingHeaders(res, upstream, target);
    res.flushHeaders?.();

    const webBody = upstream.body as import("stream/web").ReadableStream<Uint8Array>;
    const nodeReadable = Readable.fromWeb(webBody);
    await pipeline(nodeReadable, res);
  } catch (e) {
    if (res.headersSent) {
      try {
        res.destroy?.();
      } catch {
        /* ignore */
      }
      return;
    }
    const msg =
      e instanceof Error && e.name === "AbortError"
        ? `Upstream request timed out (${Math.round(abortMs / 1000)}s).`
        : e instanceof Error
          ? e.message
          : "Proxy error";
    res.status(502).send(msg);
  } finally {
    clearTimeout(t);
  }
}
