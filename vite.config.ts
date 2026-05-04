import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import {
  handleR2PackageCoverRoute,
  isR2PackageCoverRoute,
} from "./api/r2PackageCoverShared";
import { fromBase64UrlUtf8, proxiedFullUrl } from "./api/proxyParamTransport";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Match `VITE_PROXY_PREFIX` in `src/main.ts` (e.g. `/proxy.php` on Namecheap). */
const PROXY_PREFIX = (process.env.VITE_PROXY_PREFIX ?? "/proxy").replace(/\/$/, "");

/** Per dev-server process: cookies + last HLS manifest per token dir (nginx session / Referer). */
const upstreamSession = {
  /** host → cookie name → value */
  cookieByHost: new Map<string, Record<string, string>>(),
  /** `http://host/hls/<token>/` → last successful playlist URL for that token */
  lastM3u8ByHlsDir: new Map<string, string>(),
};


function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Mask Xtream-style /live/user/pass/ segments in logs. */
function maskUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(
      /\/live\/([^/]+)\/([^/]+)(?=\/)/i,
      "/live/***/***"
    );
    if (u.password) u.password = "***";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return url.length > 160 ? `${url.slice(0, 160)}…` : url;
  }
}

function proxyDebugMode(): "all" | "errors" {
  const v = (process.env.XTREAM_PROXY_DEBUG ?? "").toLowerCase();
  if (v === "0" || v === "off" || v === "false") {
    return "errors";
  }
  if (v === "1" || v === "all" || v === "true") {
    return "all";
  }
  return "errors";
}

function logProxy(
  level: "info" | "warn",
  msg: string,
  extra?: Record<string, unknown>
): void {
  const line = extra
    ? `${msg} ${JSON.stringify(extra)}`
    : msg;
  if (level === "warn") {
    console.warn(`[xtream-proxy] ${line}`);
  } else {
    console.log(`[xtream-proxy] ${line}`);
  }
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

type Next = (err?: unknown) => void;

/** Do not forward to client; cookies stay in server-side jar. */
const PROXY_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "set-cookie",
  "etag",
  "cache-control",
  "expires",
  "last-modified",
]);

function copyUpstreamHeadersToClient(upstream: Response, res: ServerResponse): void {
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (PROXY_HOP_BY_HOP.has(lk)) return;
    try {
      res.setHeader(key, value);
    } catch {
      /* ignore invalid header names */
    }
  });
}

/** Avoid :80 / :443 in headers; some CDNs treat them as different from default. */
function stripDefaultPortHref(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && u.port === "80") {
      u.port = "";
    }
    if (u.protocol === "https:" && u.port === "443") {
      u.port = "";
    }
    return u.href;
  } catch {
    return url;
  }
}

/** Referer many CDNs expect (folder containing the file, or whole origin). */
function refererForTarget(targetUrl: string): string {
  const u = new URL(targetUrl);
  if (!u.pathname || u.pathname === "/") {
    return stripDefaultPortHref(`${u.origin}/`);
  }
  const dir = u.pathname.replace(/\/[^/]*$/, "/") || "/";
  return stripDefaultPortHref(`${u.origin}${dir}`);
}

/** `http://host/hls/<token>/` or null if not under /hls/<token>/… */
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
  if (!lines.length) return;
  let jar = upstreamSession.cookieByHost.get(host);
  if (!jar) {
    jar = Object.create(null) as Record<string, string>;
    upstreamSession.cookieByHost.set(host, jar);
  }
  for (const line of lines) {
    const p = parseSetCookieNameValue(line);
    if (p) jar[p[0]] = p[1];
  }
}

function cookieHeaderForUpstreamUrl(requestUrl: string): string | undefined {
  const host = new URL(requestUrl).host;
  const jar = upstreamSession.cookieByHost.get(host);
  if (!jar) return undefined;
  const pairs = Object.entries(jar).filter(([, v]) => v !== "");
  if (!pairs.length) return undefined;
  return pairs.map(([k, v]) => `${k}=${v}`).join("; ");
}

function buildUpstreamHeaders(
  req: IncomingMessage,
  targetUrl: string,
  fromPlaylist: string | null
): { headers: Record<string, string>; referer: string; origin: string } {
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
          /* For tokenized /hls/<token>/segment.ts URLs, many providers require Referer under the same token folder. */
          referer = refererForTarget(targetUrl);
        } else if (/\/live\//i.test(from.pathname) && targetUnderHls) {
          referer = refererForTarget(targetUrl);
        } else if (/\/live\/.+\.m3u8$/i.test(targetPath)) {
          // Some IPTV providers reject full /live/user/pass/... referers.
          referer = stripDefaultPortHref(`${target.origin}/`);
        } else if (
          /\/get_vod_info$/i.test(targetPath) ||
          /\/get_series_info$/i.test(targetPath) ||
          /\/player_api(\.php)?$/i.test(targetPath)
        ) {
          // Nodecast panels often reject self-referential API URLs (Referer = same get_* URL → 400).
          // POST /api/transcode/session: `from` equals `target` via proxiedFullUrl — never send Referer = session URL (500 on some builds).
          referer = stripDefaultPortHref(`${target.origin}/`);
        } else {
          referer = stripDefaultPortHref(from.href);
        }
      }
    } catch {
      /* ignore */
    }
  }
  const accept = req.headers.accept;
  const acceptStr = Array.isArray(accept)
    ? accept[0]
    : typeof accept === "string"
      ? accept
      : "*/*";
  const origin = stripDefaultPortHref(target.origin);
  referer = stripDefaultPortHref(referer);
  if (targetUnderHls && !/\.m3u8$/i.test(targetPath) && !targetIsTsUnderHls) {
    const dirKey = hlsTokenDirKey(targetUrl);
    const lastM3u8 = dirKey
      ? upstreamSession.lastM3u8ByHlsDir.get(dirKey)
      : undefined;
    if (lastM3u8) {
      referer = stripDefaultPortHref(lastM3u8);
    }
  }
  const isXtreamInfoEndpoint =
    /\/get_vod_info$/i.test(targetPath) ||
    /\/get_series_info$/i.test(targetPath) ||
    /\/player_api(\.php)?$/i.test(targetPath);
  const h: Record<string, string> = {
    Accept: isXtreamInfoEndpoint
      ? "application/json, text/plain;q=0.9, */*;q=0.8"
      : acceptStr || "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer,
    // IPTV providers often whitelist VLC-like UAs and block browser UAs.
    "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
  };
  const cookie = cookieHeaderForUpstreamUrl(targetUrl);
  if (cookie) {
    h.Cookie = cookie;
  }
  if (!targetUnderHls || /\.m3u8$/i.test(targetPath) || targetIsTsUnderHls) {
    h.Origin = origin;
  }
  const range = req.headers.range;
  if (typeof range === "string" && !targetIsTsUnderHls) {
    h.Range = range;
  }
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.trim()) {
    h.Authorization = authorization;
  }
  return {
    headers: h,
    referer,
    origin: h.Origin ?? "(omitted)",
  };
}

function proxyMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (!req.url?.startsWith(`${PROXY_PREFIX}?`)) {
      next();
      return;
    }
    const raw = new URL(req.url, "http://localhost");
    const qb64 = raw.searchParams.get("targetB64");
    const fb64 = raw.searchParams.get("fromB64");
    let q = raw.searchParams.get("target");
    let from = raw.searchParams.get("from");
    if (qb64) {
      try {
        q = fromBase64UrlUtf8(qb64);
      } catch {
        res.statusCode = 400;
        res.end("Bad targetB64");
        return;
      }
    }
    if (fb64) {
      try {
        from = fromBase64UrlUtf8(fb64);
      } catch {
        res.statusCode = 400;
        res.end("Bad fromB64");
        return;
      }
    }
    if (!from && q) from = q;
    if (!q || !isHttpUrl(q)) {
      res.statusCode = 400;
      res.end("Bad target");
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const debug = proxyDebugMode();
    const upstreamMsRaw = Number(process.env.XTREAM_PROXY_UPSTREAM_MS);
    let upstreamMs = Number.isFinite(upstreamMsRaw)
      ? Math.min(Math.max(upstreamMsRaw, 5_000), 900_000)
      : 120_000;
    if (
      method === "POST" &&
      /\/api\/transcode\/session(?:\?|$)/i.test(q)
    ) {
      const capRaw = Number(process.env.XTREAM_PROXY_TRANSCODE_SESSION_MS);
      const capMs = Number.isFinite(capRaw)
        ? Math.min(Math.max(capRaw, 3_000), 120_000)
        : 18_000;
      upstreamMs = Math.min(upstreamMs, capMs);
    } else if (
      method === "GET" &&
      /\/api\/proxy\/stream(?:\?|$)/i.test(q)
    ) {
      const ph = req.headers["x-playable-probe"];
      const probeVal = Array.isArray(ph) ? ph[0] : ph;
      if (typeof probeVal === "string" && probeVal.trim() === "1") {
        const capRaw = Number(process.env.XTREAM_PROXY_STREAM_PROBE_MS);
        const capMs = Number.isFinite(capRaw)
          ? Math.min(Math.max(capRaw, 3_000), 120_000)
          : 18_000;
        upstreamMs = Math.min(upstreamMs, capMs);
      }
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), upstreamMs);
    const { headers: outHeaders, referer, origin } = buildUpstreamHeaders(
      req,
      q,
      from
    );

    if (debug === "all") {
      logProxy("info", "request", {
        method: req.method ?? "GET",
        target: maskUrlForLog(q),
        from: from ? maskUrlForLog(from) : "(none)",
        referer,
        origin,
        range: outHeaders.Range ?? "(none)",
        clientHost: req.headers.host ?? "(unknown)",
      });
    }

    try {
      let requestBody: Buffer | undefined;
      if (method !== "GET" && method !== "HEAD") {
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        } catch {
          /* ignore */
        }
        const buf = Buffer.concat(chunks);
        requestBody = buf.length > 0 ? buf : undefined;
      }
      const contentType = req.headers["content-type"];
      if (typeof contentType === "string" && requestBody && requestBody.length > 0) {
        outHeaders["Content-Type"] = contentType;
      }
      if (requestBody && requestBody.length > 0) {
        outHeaders["Content-Length"] = String(requestBody.length);
      }
      if (
        debug === "all" &&
        q.includes("/api/transcode/session") &&
        requestBody &&
        requestBody.length > 0
      ) {
        const bodyPreview = requestBody.toString("utf8").replace(/\s+/g, " ").slice(0, 300);
        logProxy("info", "transcode-request-body", {
          target: maskUrlForLog(q),
          contentType: outHeaders["Content-Type"] ?? "(none)",
          bytes: requestBody.length,
          bodyPreview,
        });
      }

      const upstream = await fetch(q, {
        signal: ac.signal,
        method,
        headers: outHeaders,
        body: requestBody,
      });
      ingestUpstreamSetCookies(upstream, q);
      const ct =
        upstream.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      const isM3u8Rewrite =
        upstream.ok &&
        (ct === "application/vnd.apple.mpegurl" ||
          ct === "application/x-mpegURL" ||
          q.toLowerCase().includes(".m3u8"));

      if (isM3u8Rewrite) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        const dirKey = hlsTokenDirKey(q);
        if (dirKey) {
          upstreamSession.lastM3u8ByHlsDir.set(
            dirKey,
            stripDefaultPortHref(q)
          );
        }
        if (debug === "all") {
          logProxy("info", "upstream", {
            status: upstream.status,
            ok: upstream.ok,
            contentType: ct || "(empty)",
            bytes: buf.length,
            target: maskUrlForLog(q),
          });
        }
        const text = buf.toString("utf8");
        const rewritten = rewriteM3u8(text, q);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.end(rewritten);
        return;
      }

      if (!upstream.ok) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (debug === "all") {
          logProxy("info", "upstream", {
            status: upstream.status,
            ok: upstream.ok,
            contentType: ct || "(empty)",
            bytes: buf.length,
            target: maskUrlForLog(q),
          });
        }
        const textProbe = buf.slice(0, 800).toString("utf8");
        const looksBinary = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(textProbe);
        const isTranscode =
          q.includes("/api/transcode/session") && upstream.status === 400;
        logProxy("warn", "upstream-error", {
          status: upstream.status,
          statusText: upstream.statusText,
          target: maskUrlForLog(q),
          from: from ? maskUrlForLog(from) : "(none)",
          refererSent: referer,
          originSent: origin,
          cookieSent: outHeaders.Cookie ? "(yes)" : "(no)",
          rangeSent: outHeaders.Range ?? "(none)",
          contentType: ct || "(empty)",
          ...(isTranscode
            ? {
                clientMethod: method,
                forwardedBodyBytes: requestBody?.length ?? 0,
                forwardedContentType:
                  outHeaders["Content-Type"] ?? "(none)",
              }
            : {}),
          bodyPreview: looksBinary
            ? `(binary or non-utf8, ${buf.length} bytes)`
            : textProbe.replace(/\s+/g, " ").slice(0, 400),
        });
        const srv = upstream.headers.get("server");
        if (srv) {
          logProxy("warn", "upstream-server-header", { server: srv });
        }
        res.statusCode = upstream.status;
        if (ct) res.setHeader("Content-Type", ct);
        res.end(buf);
        return;
      }

      if (
        upstream.status === 204 ||
        upstream.status === 304 ||
        method === "HEAD" ||
        !upstream.body
      ) {
        res.statusCode = upstream.status;
        copyUpstreamHeadersToClient(upstream, res);
        res.end();
        return;
      }

      if (debug === "all") {
        logProxy("info", "upstream", {
          status: upstream.status,
          ok: upstream.ok,
          contentType: ct || "(empty)",
          bytes: "(streaming)",
          target: maskUrlForLog(q),
        });
      }

      res.once("close", () => {
        try {
          ac.abort();
        } catch {
          /* ignore */
        }
      });
      res.statusCode = upstream.status;
      copyUpstreamHeadersToClient(upstream, res);
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
      const sec = Math.round(upstreamMs / 1000);
      const msg =
        e instanceof Error && e.name === "AbortError"
          ? `Upstream request timed out (${sec}s). Set XTREAM_PROXY_UPSTREAM_MS to adjust.`
          : e instanceof Error
            ? e.message
            : "Proxy error";
      logProxy("warn", "fetch-threw", {
        message: msg,
        target: maskUrlForLog(q),
        from: from ? maskUrlForLog(from) : "(none)",
        refererSent: referer,
        stack: e instanceof Error ? e.stack : undefined,
      });
      res.statusCode = 502;
      res.end(msg);
    } finally {
      clearTimeout(t);
    }
  };
}

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, process.cwd(), "");
  const viteAutoconnect = Boolean(
    rootEnv.VITE_NODECAST_URL?.trim() && rootEnv.VITE_NODECAST_USERNAME?.trim()
  );

  return {
    envPrefix: ["VITE_", "NEXT_PUBLIC_"],
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
        },
      },
    },
    server: {
      middlewareMode: false,
    },
    plugins: [
      {
        name: "vite-autoconnect-html",
        transformIndexHtml: {
          order: "pre",
          handler(html, ctx) {
            if (!viteAutoconnect) return html;
            const name = ctx.filename.replace(/\\/g, "/");
            if (!name.endsWith("/index.html") && !name.endsWith("\\index.html")) return html;
            let out = html.replace("<body>", '<body class="vite-autoconnect">');
            if (!out.includes("vite-autoconnect")) {
              out = html.replace("<body ", '<body class="vite-autoconnect" ');
            }
            out = out.replace('class="main main--velora hidden"', 'class="main main--velora"');
            return out;
          },
        },
      },
      {
        name: "r2-package-cover-upload",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!isR2PackageCoverRoute(req.url)) {
              next();
              return;
            }
            const merged = { ...process.env, ...loadEnv(server.config.mode, process.cwd(), "") };
            void handleR2PackageCoverRoute(req, res, merged);
          });
        },
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!isR2PackageCoverRoute(req.url)) {
              next();
              return;
            }
            const merged = { ...process.env, ...loadEnv(server.config.mode, process.cwd(), "") };
            void handleR2PackageCoverRoute(req, res, merged);
          });
        },
      },
      {
        name: "xtream-media-proxy",
        configureServer(server) {
          console.log(
            "[xtream-proxy] Proxy ready. Failed upstream responses are logged. Verbose: XTREAM_PROXY_DEBUG=1 npm run dev"
          );
          server.middlewares.use(proxyMiddleware());
        },
        configurePreviewServer(server) {
          console.log(
            "[xtream-proxy] Preview proxy ready. Verbose: XTREAM_PROXY_DEBUG=1 npm run preview"
          );
          server.middlewares.use(proxyMiddleware());
        },
      },
    ],
  };
});
