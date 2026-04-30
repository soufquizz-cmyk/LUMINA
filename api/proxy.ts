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
  const h: Record<string, string> = {
    Accept: acceptStr,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer,
    "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
  };
  const cookie = cookieHeaderForUpstreamUrl(targetUrl);
  if (cookie) h.Cookie = cookie;
  if (!targetUnderHls || /\.m3u8$/i.test(targetPath) || targetIsTsUnderHls) {
    h.Origin = origin;
  }
  const range = getHeader(req, "range");
  if (range && !targetIsTsUnderHls) h.Range = range;
  const authorization = getHeader(req, "authorization");
  if (authorization?.trim()) h.Authorization = authorization;
  return h;
}

function rewriteM3u8(body: string, playlistUrl: string): string {
  const base = new URL(playlistUrl);
  const proxy = (absolute: string) => {
    const p = new URLSearchParams();
    p.set("target", absolute);
    p.set("from", playlistUrl);
    return `/proxy?${p.toString()}`;
  };
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
  "transfer-encoding",
  "content-encoding",
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
  const target = url.searchParams.get("target");
  const from = url.searchParams.get("from");

  if (!target || !isHttpUrl(target)) {
    res.status(400).send("Bad target");
    return;
  }

  if (!isAllowedTarget(target)) {
    res
      .status(403)
      .send(
        "Proxy target host not allowed. Set PROXY_ALLOWED_HOSTS on Vercel (comma-separated host or host:port)."
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
  const t = setTimeout(() => ac.abort(), 60_000);
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
      res.status(200);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
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
        ? "Upstream request timed out (60s)."
        : e instanceof Error
          ? e.message
          : "Proxy error";
    res.status(502).send(msg);
  } finally {
    clearTimeout(t);
  }
}
