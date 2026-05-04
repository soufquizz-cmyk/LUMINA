/** Shared Nodecast catalog loading + stream URL resolution. */

import { proxiedFullUrl } from "./proxyParamTransport";

export type LiveCategory = {
  category_id: string;
  category_name: string;
  parent_id: number;
};

export type LiveStream = {
  stream_id: number;
  name: string;
  category_id?: string | number;
  stream_icon?: string;
  epg_channel_id?: string | null;
  direct_source?: string;
  nodecast_channel_id?: string;
  nodecast_source_id?: string;
  /** Xtream via Nodecast: VOD movie / series row (playback URL differs from live). */
  nodecast_media?: "live" | "vod" | "series";
  /** VOD row: container from panel (e.g. mp4) for `/movie/{id}.{ext}` proxy paths. */
  container_extension?: string;
};

export type ProxiedRequestInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Abort fetch after this many ms (default 90s). Use ~15–25s for transcode session POST. */
  timeoutMs?: number;
};

const PROXY_PREFIX = (import.meta.env.VITE_PROXY_PREFIX ?? "/proxy").replace(/\/$/, "");

export function normalizeServerInput(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  return s;
}

export function proxiedUrl(target: string, fromPlaylist?: string): string {
  return proxiedFullUrl(PROXY_PREFIX, target, fromPlaylist);
}

/**
 * Package / hero images: use `/proxy` for arbitrary HTTPS (IPTV CDNs, etc.).
 * Skip the proxy for **R2 public** `*.r2.dev` URLs — Node's upstream `fetch` to R2 often fails
 * (`TypeError: fetch failed`) while the browser loads the same URL fine in `<img>` (no CORS needed).
 * Canvas-based flows (e.g. theme sampling in `packageImageTheme.ts`) still use `proxiedUrl` for R2.
 */
export function imageUrlForDisplay(href: string): string {
  const t = href.trim();
  if (!t || !/^https?:\/\//i.test(t)) return t;
  try {
    const h = new URL(t).hostname.toLowerCase();
    if (h.endsWith(".r2.dev")) return t;
  } catch {
    /* ignore */
  }
  return proxiedUrl(t);
}

const FETCH_TIMEOUT_MS = 90_000;
/** POST /api/transcode/session should fail fast when the panel is broken (e.g. ENOENT on cache). */
const TRANSCODE_SESSION_FETCH_MS = 18_000;
const TRANSCODE_PROBE_WARM_FETCH_MS = 12_000;
/** GET via `/proxy` to decide if a URL is playable — must not hang on stalled Nodecast/CDN streams. */
const PLAYABLE_PROBE_FETCH_MS = 18_000;
const TRANSCODE_CACHE_MS = 3 * 60 * 1000;
const transcodePlaylistCache = new Map<string, { expires: number; playlistUrl: string }>();
const transcodeInflight = new Map<string, Promise<string | null>>();

export async function fetchProxiedJson<T>(url: string): Promise<T> {
  return fetchProxiedJsonWithInit<T>(url);
}

export async function fetchProxiedJsonWithInit<T>(
  url: string,
  init: ProxiedRequestInit = {}
): Promise<T> {
  const ac = new AbortController();
  const rawMs = init.timeoutMs ?? FETCH_TIMEOUT_MS;
  const effectiveMs = Math.min(Math.max(rawMs, 3_000), 120_000);
  const timer = setTimeout(() => ac.abort(), effectiveMs);
  let r: Response;
  try {
    r = await fetch(proxiedUrl(url), {
      signal: ac.signal,
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `Request timed out after ${effectiveMs / 1000}s. Check the server URL and your network.`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = (await r.text()).replace(/^\uFEFF/, "");
  if (!r.ok) {
    throw new Error(text.slice(0, 400) || r.statusText);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON from server (wrong URL or blocked response).");
  }
}

function asArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.channels)) return o.channels;
  /** Xtream `player_api` style: get_series → `{ series: [...] }`, categories → `{ categories: [...] }`. */
  if (Array.isArray(o.series)) return o.series;
  if (Array.isArray(o.categories)) return o.categories;
  if (Array.isArray(o.movie_data)) return o.movie_data;
  if (Array.isArray(o.movies)) return o.movies;
  if (Array.isArray(o.vod_streams)) return o.vod_streams;
  if (Array.isArray(o.streams)) return o.streams;
  if (Array.isArray(o.data)) return o.data;
  if (Array.isArray(o.items)) return o.items;
  if (Array.isArray(o.results)) return o.results;
  if (Array.isArray(o.favorites)) return o.favorites;
  if (Array.isArray(o.favoriteItems)) return o.favoriteItems;
  if (Array.isArray(o.records)) return o.records;
  if (Array.isArray(o.list)) return o.list;
  if (Array.isArray(o.payload)) return o.payload;
  if (Array.isArray(o.content)) return o.content;
  if (Array.isArray(o.favoriteSeries)) return o.favoriteSeries;
  if (Array.isArray(o.favorite_series)) return o.favorite_series;
  if (Array.isArray(o.series_list)) return o.series_list;
  /** Some forks expose series rows under `js` (PHP array name). */
  if (Array.isArray(o.js)) return o.js;
  /** Some panels wrap lists in `data: { series: [...] }` (non-array `data`). */
  if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
    const nested = asArray(o.data);
    if (nested.length) return nested;
  }
  return [];
}

/**
 * Many Xtream-style panels return `get_series` as an object whose keys are category ids and
 * values are arrays of series rows — not a flat array. Flatten those into one list (with
 * `category_id` filled from the key when missing).
 */
function tryFlattenCategoryKeyedSeriesMap(p: unknown): unknown[] | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  const metaKeys = new Set([
    "success",
    "user_info",
    "server_info",
    "categories",
    "episodes",
    "seasons",
    "info",
    "message",
    "error",
    "status",
  ]);
  const buckets: { key: string; rows: unknown[] }[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (metaKeys.has(k.toLowerCase())) continue;
    if (!Array.isArray(v) || v.length < 1) continue;
    const first = v[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) continue;
    const r = first as Record<string, unknown>;
    const looks =
      r.series_id != null ||
      r.seriesId != null ||
      r.stream_id != null ||
      r.streamId != null ||
      (typeof r.name === "string" && r.name.trim().length > 0) ||
      (typeof r.title === "string" && r.title.trim().length > 0) ||
      (typeof r.series_name === "string" && r.series_name.trim().length > 0);
    if (!looks) continue;
    if (/^\d+$/.test(k)) buckets.push({ key: k, rows: v });
  }
  if (!buckets.length) return null;
  const out: unknown[] = [];
  for (const { key, rows } of buckets) {
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const ro = row as Record<string, unknown>;
      out.push({
        ...ro,
        category_id: ro.category_id ?? ro.category_ids ?? key,
      });
    }
  }
  return out.length ? out : null;
}

/**
 * Liste de lignes séries / favoris : `asArray` + chaînes JSON, clés `result`/`response`/`body`,
 * et objets « map » dont les valeurs ressemblent à des lignes Xtream.
 */
function seriesListFromPayload(payload: unknown, depth = 0): unknown[] {
  if (depth > 8) return [];
  let p: unknown = payload;
  if (typeof p === "string") {
    const t = p.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return [];
    try {
      p = JSON.parse(t) as unknown;
    } catch {
      return [];
    }
  }
  const fromCatMap = tryFlattenCategoryKeyedSeriesMap(p);
  if (fromCatMap?.length) return fromCatMap;
  const direct = asArray(p);
  if (direct.length) return direct;
  if (!p || typeof p !== "object" || Array.isArray(p)) return [];
  const o = p as Record<string, unknown>;
  for (const key of ["data", "result", "response", "body", "value", "series"]) {
    const inner = o[key];
    if (inner == null || typeof inner !== "object") continue;
    const got = seriesListFromPayload(inner, depth + 1);
    if (got.length) return got;
  }
  const vals = Object.values(o);
  if (vals.length < 1 || vals.length > 100_000) return [];
  const first = vals[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return [];
  const r = first as Record<string, unknown>;
  const looksLikeSeriesRow =
    r.series_id != null ||
    r.seriesId != null ||
    r.stream_id != null ||
    typeof r.name === "string" ||
    typeof r.title === "string";
  if (!looksLikeSeriesRow) return [];
  const allRecords = vals.every((v) => v != null && typeof v === "object" && !Array.isArray(v));
  return allRecords ? vals : [];
}

function canonicalHttpUrlFromMaybeEncoded(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 8; i++) {
    if (!/%[0-9A-Fa-f]{2}/i.test(s)) break;
    try {
      const d = decodeURIComponent(s);
      if (d === s) break;
      s = d;
    } catch {
      break;
    }
  }
  return s;
}

/** Peel Nodecast `/api/proxy/stream?url=` wrappers (possibly nested / double-encoded) to the real CDN URL. */
function innermostHttpStreamTarget(urlOrProxy: string): string {
  let s = urlOrProxy.trim();
  for (let depth = 0; depth < 6; depth++) {
    try {
      const u = new URL(s);
      if (!/\/api\/proxy\/stream$/i.test(u.pathname)) {
        return canonicalHttpUrlFromMaybeEncoded(s);
      }
      const inner = u.searchParams.get("url");
      if (!inner?.trim()) {
        return canonicalHttpUrlFromMaybeEncoded(s);
      }
      s = canonicalHttpUrlFromMaybeEncoded(inner.trim());
    } catch {
      return canonicalHttpUrlFromMaybeEncoded(s);
    }
  }
  return canonicalHttpUrlFromMaybeEncoded(s);
}

function looksLikeMediaUrl(v: string): boolean {
  const s = canonicalHttpUrlFromMaybeEncoded(v);
  return (
    /^https?:\/\//i.test(s) &&
    /(\.m3u8|\.mpd|\.ts|\.mp4|\.mkv|\.mov|\/live\/|\/hls\/|\/stream\/|\/movie\/|\/vod\/)/i.test(
      s
    )
  );
}

function extractStreamUrlDeep(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return looksLikeMediaUrl(trimmed) ? canonicalHttpUrlFromMaybeEncoded(trimmed) : null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const hit = extractStreamUrlDeep(item);
      if (hit) return hit;
    }
    return null;
  }

  const obj = payload as Record<string, unknown>;
  const preferredKeys = [
    "stream_url",
    "playback_url",
    "hls_url",
    "url",
    "direct_source",
    "stream",
    "play_url",
  ];
  for (const k of preferredKeys) {
    const v = obj[k];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (looksLikeMediaUrl(trimmed)) return canonicalHttpUrlFromMaybeEncoded(trimmed);
    }
  }
  for (const v of Object.values(obj)) {
    const hit = extractStreamUrlDeep(v);
    if (hit) return hit;
  }
  return null;
}

function extractTokenDeep(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const t = extractTokenDeep(item);
      if (t) return t;
    }
    return null;
  }
  const o = payload as Record<string, unknown>;
  const directKeys = ["token", "access_token", "accessToken", "jwt", "bearer"];
  for (const k of directKeys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(o)) {
    const t = extractTokenDeep(v);
    if (t) return t;
  }
  return null;
}

function isLikelyM3u8Body(text: string): boolean {
  return text.trimStart().startsWith("#EXTM3U");
}

function cancelFetchResponseBody(r: Response): void {
  try {
    void r.body?.cancel();
  } catch {
    /* ignore */
  }
}

function hrefLooksLikeProgressiveContainer(href: string): boolean {
  const s = innermostHttpStreamTarget(href);
  return /\.(mp4|mkv|webm|mov|avi|m4v)(\?|#|&|$)/i.test(s);
}

const NODECAST_SETTINGS_CACHE_MS = 5 * 60 * 1000;
let nodecastProbeUaCache: { base: string; ua: string; exp: number } | null = null;

async function nodecastProbeUrl(
  nodecastBase: string,
  upstreamUrl: string,
  headers?: Record<string, string>
): Promise<string> {
  const b = nodecastBase.replace(/\/+$/, "");
  let ua = "vlc";
  const now = Date.now();
  if (
    nodecastProbeUaCache &&
    nodecastProbeUaCache.base === b &&
    nodecastProbeUaCache.exp > now
  ) {
    ua = nodecastProbeUaCache.ua;
  } else {
    try {
      const s = await fetchProxiedJsonWithInit<Record<string, unknown>>(
        `${b}/api/settings`,
        { headers }
      );
      const preset =
        typeof s.userAgentPreset === "string" ? s.userAgentPreset.trim().toLowerCase() : "";
      if (preset === "vlc" || preset === "chrome" || preset === "firefox") ua = preset;
      else if (preset) ua = preset.replace(/\s+/g, "_").slice(0, 48);
      nodecastProbeUaCache = { base: b, ua, exp: now + NODECAST_SETTINGS_CACHE_MS };
    } catch {
      nodecastProbeUaCache = { base: b, ua: "vlc", exp: now + 60_000 };
    }
  }
  return `${b}/api/probe?url=${encodeURIComponent(upstreamUrl)}&ua=${encodeURIComponent(ua)}`;
}

function playlistUrlFromNodecastTranscodeResponse(
  payload: unknown,
  nodecastBase: string
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const rel = o.playlistUrl;
  if (typeof rel !== "string" || !rel.includes("m3u8")) return null;
  try {
    const u = new URL(rel.trim(), nodecastBase);
    if (u.origin !== new URL(nodecastBase).origin) return null;
    return u.href;
  } catch {
    return null;
  }
}

async function createNodecastTranscodeUrl(
  nodecastBase: string,
  upstreamUrlRaw: string,
  headers?: Record<string, string>
): Promise<string | null> {
  const upstreamUrl = innermostHttpStreamTarget(upstreamUrlRaw);
  const now = Date.now();
  const cached = transcodePlaylistCache.get(upstreamUrl);
  if (cached && cached.expires > now) {
    return cached.playlistUrl;
  }

  let inflight = transcodeInflight.get(upstreamUrl);
  if (inflight) {
    return inflight;
  }

  inflight = (async (): Promise<string | null> => {
    try {
      const probe = await nodecastProbeUrl(nodecastBase, upstreamUrl, headers);
      await fetchProxiedJsonWithInit<unknown>(probe, {
        headers,
        timeoutMs: TRANSCODE_PROBE_WARM_FETCH_MS,
      });
    } catch {
      // optional warm-up
    }

    const postHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    };
    const postBody = JSON.stringify({ url: upstreamUrl });
    const sessionUrl = `${nodecastBase}/api/transcode/session`;

    for (let round = 0; round < 2; round++) {
      if (round > 0) {
        await new Promise((r) => setTimeout(r, 2800));
      }
      try {
        const payload = await fetchProxiedJsonWithInit<unknown>(sessionUrl, {
          method: "POST",
          headers: postHeaders,
          body: postBody,
          timeoutMs: TRANSCODE_SESSION_FETCH_MS,
        });
        const fromPlaylist = playlistUrlFromNodecastTranscodeResponse(payload, nodecastBase);
        if (fromPlaylist) {
          transcodePlaylistCache.set(upstreamUrl, {
            expires: Date.now() + TRANSCODE_CACHE_MS,
            playlistUrl: fromPlaylist,
          });
          return fromPlaylist;
        }
        const resolved = extractStreamUrlDeep(payload);
        if (resolved) {
          const u = new URL(resolved, nodecastBase);
          if (u.origin === new URL(nodecastBase).origin) {
            transcodePlaylistCache.set(upstreamUrl, {
              expires: Date.now() + TRANSCODE_CACHE_MS,
              playlistUrl: u.href,
            });
            return u.href;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isPlaylistTimeout = msg.includes("Playlist not generated in time");
        if (!isPlaylistTimeout || round === 1) {
          break;
        }
      }
    }
    return null;
  })().finally(() => {
    transcodeInflight.delete(upstreamUrl);
  });

  transcodeInflight.set(upstreamUrl, inflight);
  return inflight;
}

function buildNodecastProxyStreamPlaylistUrl(nodecastBase: string, upstreamUrl: string): string {
  const b = nodecastBase.replace(/\/+$/, "");
  const inner = innermostHttpStreamTarget(upstreamUrl);
  return `${b}/api/proxy/stream?url=${encodeURIComponent(inner)}`;
}

async function resolveCandidateToPlayableUrl(
  candidate: string,
  headers?: Record<string, string>
): Promise<string | null> {
  let c = candidate.trim();
  try {
    const u = new URL(c);
    if (/\/api\/proxy\/stream$/i.test(u.pathname)) {
      const origin = `${u.protocol}//${u.host}`;
      c = buildNodecastProxyStreamPlaylistUrl(origin, innermostHttpStreamTarget(c));
    }
  } catch {
    /* keep c */
  }
  try {
    const ac = new AbortController();
    const probeTimer = setTimeout(() => ac.abort(), PLAYABLE_PROBE_FETCH_MS);
    const probeHeaders: Record<string, string> = {
      ...(headers ?? {}),
      "X-Playable-Probe": "1",
    };
    let r: Response;
    try {
      r = await fetch(proxiedUrl(c), {
        method: "GET",
        headers: probeHeaders,
        signal: ac.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(probeTimer);
    }
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();

    if (
      ct.includes("video/") &&
      !ct.includes("mpegurl") &&
      !ct.includes("x-mpegurl")
    ) {
      cancelFetchResponseBody(r);
      return c;
    }
    if (ct.includes("application/octet-stream")) {
      if (/\.m3u8(\?|$)/i.test(c)) {
        /* read body below — may still be a playlist */
      } else if (
        /(\.(mp4|mkv|avi|mov|webm)(\?|$))|\/movie\/[^/?]+(\?|$)|\/vod\/[^/?]+(\?|$)/i.test(
          c
        )
      ) {
        cancelFetchResponseBody(r);
        return c;
      }
    }

    const body = await r.text();

    if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) {
      return isLikelyM3u8Body(body) ? c : null;
    }
    if (isLikelyM3u8Body(body)) {
      return c;
    }

    if (ct.includes("application/json") || body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
      try {
        const parsed = JSON.parse(body) as unknown;
        const extracted = extractStreamUrlDeep(parsed);
        if (!extracted) return null;
        const extractedAbs = canonicalHttpUrlFromMaybeEncoded(extracted);
        try {
          const candidateUrl = new URL(c);
          const extractedUrl = /^https?:\/\//i.test(extractedAbs)
            ? new URL(extractedAbs)
            : new URL(extractedAbs, candidateUrl);
          if (extractedUrl.origin !== candidateUrl.origin) {
            const nodecastOrigin = `${candidateUrl.protocol}//${candidateUrl.host}`;
            const viaProxyInner = buildNodecastProxyStreamPlaylistUrl(nodecastOrigin, extractedUrl.href);
            if (hrefLooksLikeProgressiveContainer(extractedUrl.href)) {
              const t = await createNodecastTranscodeUrl(nodecastOrigin, extractedUrl.href, headers);
              if (t) return t;
              return await resolveCandidateToPlayableUrl(viaProxyInner, headers);
            }
            const playable = await resolveCandidateToPlayableUrl(viaProxyInner, headers);
            if (playable) return playable;
            return await createNodecastTranscodeUrl(nodecastOrigin, extractedUrl.href, headers);
          }
          if (/\/api\/proxy\/stream$/i.test(extractedUrl.pathname)) {
            return buildNodecastProxyStreamPlaylistUrl(
              `${extractedUrl.protocol}//${extractedUrl.host}`,
              innermostHttpStreamTarget(extractedUrl.href)
            );
          }
          return extractedUrl.href;
        } catch {
          return null;
        }
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function mapNodecastChannelToLiveStream(raw: unknown, index: number): LiveStream | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const name = String(c.name ?? c.title ?? `Channel ${index + 1}`).trim();
  const directSource = extractStreamUrlDeep(c) ?? "";
  if (!name) return null;

  const categoryId = String(
    c.category_id ??
      c.group_id ??
      c.group ??
      c.category ??
      c.source_id ??
      "uncategorized"
  );
  const numericId = Number(c.stream_id ?? c.id ?? index + 1);
  const iconRaw =
    (typeof c.stream_icon === "string" && c.stream_icon.trim()) ||
    (typeof c.logo === "string" && c.logo.trim()) ||
    (typeof c.cover === "string" && c.cover.trim()) ||
    (typeof c.icon === "string" && c.icon.trim()) ||
    "";
  const containerExtRaw =
    typeof c.container_extension === "string" ? c.container_extension.trim() : "";
  const container_extension =
    containerExtRaw && /^[a-z0-9]+$/i.test(containerExtRaw)
      ? containerExtRaw.toLowerCase()
      : undefined;
  return {
    stream_id: Number.isFinite(numericId) ? numericId : index + 1,
    name,
    category_id: categoryId,
    stream_icon: iconRaw || undefined,
    direct_source: directSource || undefined,
    container_extension,
    nodecast_channel_id: String(c.channel_id ?? c.id ?? c.stream_id ?? ""),
  };
}

export function groupStreamsByCategory(streams: LiveStream[]): Map<string, LiveStream[]> {
  const map = new Map<string, LiveStream[]>();
  for (const s of streams) {
    const cid = s.category_id != null ? String(s.category_id) : "";
    if (!cid) continue;
    const list = map.get(cid);
    if (list) list.push(s);
    else map.set(cid, [s]);
  }
  return map;
}

function categoriesFromStreams(streams: LiveStream[]): LiveCategory[] {
  const seen = new Map<string, LiveCategory>();
  for (const s of streams) {
    const cid = String(s.category_id ?? "uncategorized");
    if (!seen.has(cid)) {
      seen.set(cid, {
        category_id: cid,
        category_name: cid === "uncategorized" ? "Other" : cid,
        parent_id: 0,
      });
    }
  }
  return [...seen.values()];
}

function parseIdCandidates(payload: unknown): string[] {
  if (!payload) return [];
  const out = new Set<string>();
  const arr = Array.isArray(payload) ? payload : asArray(payload);
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? o.source_id ?? o.connection_id ?? "").trim();
    const type = String(o.type ?? o.kind ?? o.source_type ?? "").toLowerCase();
    const provider = String(o.provider ?? o.name ?? "").toLowerCase();
    if (!id) continue;
    if (!type && !provider) {
      out.add(id);
      continue;
    }
    if (type.includes("xtream") || provider.includes("xtream")) {
      out.add(id);
    }
  }
  return [...out];
}

function collectXtreamSourceIdsFromStatus(payload: unknown): string[] {
  const out = new Set<string>();
  const arr = Array.isArray(payload) ? payload : asArray(payload);
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const err = o.error;
    if (typeof err === "string" && err.trim()) continue;
    const status = String(o.status ?? "").toLowerCase();
    if (status && status !== "success") continue;
    const id = String(o.source_id ?? o.sourceId ?? o.id ?? "").trim();
    if (!id) continue;
    out.add(id);
  }
  return [...out];
}

export type NodecastCatalogLoadResult = {
  categories: LiveCategory[];
  streamsByCat: Map<string, LiveStream[]>;
  authHeaders?: Record<string, string>;
  /** Xtream source id used for `/api/proxy/xtream/{id}/…` (VOD / series). */
  nodecastXtreamSourceId?: string;
  vodCategories: LiveCategory[];
  vodStreamsByCat: Map<string, LiveStream[]>;
  seriesCategories: LiveCategory[];
  seriesStreamsByCat: Map<string, LiveStream[]>;
};

async function discoverXtreamSourceIdsInternal(
  base: string,
  nodecastAuthHeaders: Record<string, string> | undefined
): Promise<string[]> {
  const sourceIdEndpoints = [
    "/api/sources/status",
    "/api/xtream/connections",
    "/api/sources",
    "/api/proxy/xtream",
  ];
  const sourceIds = new Set<string>();
  for (const ep of sourceIdEndpoints) {
    try {
      const payload = await fetchProxiedJsonWithInit<unknown>(`${base}${ep}`, {
        headers: nodecastAuthHeaders,
      });
      if (ep === "/api/sources/status") {
        for (const id of collectXtreamSourceIdsFromStatus(payload)) sourceIds.add(id);
      } else {
        for (const id of parseIdCandidates(payload)) sourceIds.add(id);
      }
    } catch {
      /* keep trying */
    }
  }
  return [...sourceIds];
}

function mapXtreamCategoryRow(raw: unknown): LiveCategory | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = String(o.category_id ?? o.id ?? "").trim();
  const name = String(o.category_name ?? o.name ?? id).trim();
  if (!id) return null;
  return { category_id: id, category_name: name, parent_id: 0 };
}

function numericXtreamSeriesId(c: Record<string, unknown>, index: number): number {
  const tryNum = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      const n = Number(v.trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
  };
  for (const k of [
    "series_id",
    "seriesId",
    "xtream_series_id",
    "xtreamSeriesId",
    "stream_id",
    "id",
  ] as const) {
    const n = tryNum(c[k]);
    if (n != null) return n;
  }
  return index + 1;
}

function mapNodecastSeriesToStream(
  raw: unknown,
  index: number,
  sourceId: string,
  /** When API omits `category_id` (per-category fetch), bucket under this package id. */
  defaultCategoryId?: string
): LiveStream | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const name = String(
    c.name ??
      c.title ??
      c.series_name ??
      c.seriesName ??
      c.label ??
      c.displayName ??
      c.display_name ??
      c.seriesTitle ??
      `Série ${index + 1}`
  ).trim();
  if (!name) return null;
  const seriesId = numericXtreamSeriesId(c, index);
  const catRaw = c.category_id ?? c.category_ids;
  let categoryId: string;
  if (Array.isArray(catRaw) && catRaw.length) {
    categoryId = String(catRaw[0]).trim();
  } else if (catRaw != null && String(catRaw).trim() !== "") {
    categoryId = String(catRaw).trim();
  } else {
    const d = defaultCategoryId?.trim();
    categoryId = d && d.length > 0 ? d : "uncategorized";
  }
  const iconRaw =
    (typeof c.cover === "string" && c.cover.trim()) ||
    (typeof c.stream_icon === "string" && c.stream_icon.trim()) ||
    (typeof c.cover_big === "string" && c.cover_big.trim()) ||
    "";
  return {
    stream_id: Number.isFinite(seriesId) ? seriesId : index + 1,
    name,
    category_id: categoryId,
    stream_icon: iconRaw || undefined,
    nodecast_source_id: sourceId,
    nodecast_media: "series",
  };
}

/** Lazy-load VOD (Films) after login — not called during initial DIRECT TV load. */
export async function fetchNodecastVodCatalog(
  base: string,
  sourceId: string,
  headers?: Record<string, string>
): Promise<{ categories: LiveCategory[]; streamsByCat: Map<string, LiveStream[]> } | null> {
  return loadXtreamVodCatalog(base, sourceId, headers);
}

/** Lazy-load séries after login — not called during initial DIRECT TV load. */
export async function fetchNodecastSeriesCatalog(
  base: string,
  sourceId: string,
  headers?: Record<string, string>
): Promise<{ categories: LiveCategory[]; streamsByCat: Map<string, LiveStream[]> } | null> {
  return loadXtreamSeriesCatalog(base, sourceId, headers);
}

async function loadXtreamVodCatalog(
  base: string,
  sourceId: string,
  headers?: Record<string, string>
): Promise<{ categories: LiveCategory[]; streamsByCat: Map<string, LiveStream[]> } | null> {
  try {
    const [catPayload, streamPayload] = await Promise.all([
      fetchProxiedJsonWithInit<unknown>(
        `${base}/api/proxy/xtream/${encodeURIComponent(sourceId)}/vod_categories`,
        { headers }
      ),
      fetchProxiedJsonWithInit<unknown>(
        `${base}/api/proxy/xtream/${encodeURIComponent(sourceId)}/vod_streams`,
        { headers }
      ),
    ]);
    const mappedStreams = asArray(streamPayload)
      .map((item, idx) => mapNodecastChannelToLiveStream(item, idx))
      .filter((s): s is LiveStream => s != null)
      .map((s) => ({
        ...s,
        nodecast_source_id: sourceId,
        nodecast_media: "vod" as const,
      }));
    if (!mappedStreams.length) return null;
    const mappedCats = asArray(catPayload)
      .map(mapXtreamCategoryRow)
      .filter((c): c is LiveCategory => c != null);
    const categories = mappedCats.length ? mappedCats : categoriesFromStreams(mappedStreams);
    return { categories, streamsByCat: groupStreamsByCategory(mappedStreams) };
  } catch {
    return null;
  }
}

async function loadXtreamSeriesCatalog(
  base: string,
  sourceId: string,
  headers?: Record<string, string>
): Promise<{ categories: LiveCategory[]; streamsByCat: Map<string, LiveStream[]> } | null> {
  const sid = encodeURIComponent(sourceId);
  const root = `${base}/api/proxy/xtream/${sid}`;
  let seriesCats: LiveCategory[] = [];
  try {
    const catPayload = await fetchProxiedJsonWithInit<unknown>(`${root}/series_categories`, {
      headers,
    });
    seriesCats = asArray(catPayload)
      .map(mapXtreamCategoryRow)
      .filter((c): c is LiveCategory => c != null);
  } catch {
    /* categories optional if get_series returns all */
  }

  const mapChunk = (payload: unknown, defaultCat?: string): LiveStream[] =>
    seriesListFromPayload(payload)
      .map((item, idx) => mapNodecastSeriesToStream(item, idx, sourceId, defaultCat))
      .filter((s): s is LiveStream => s != null);

  /** Plusieurs panels / proxys refusent `get_series` sans `category_id` (400) — variantes par catégorie. */
  function seriesUrlsForCategory(categoryId: string): string[] {
    const enc = encodeURIComponent(categoryId);
    return [
      /** Nodecast-style REST (same panel as `series_categories`). */
      `${root}/series?category_id=${enc}`,
      `${root}/series?cat_id=${enc}`,
      `${root}/series/${enc}`,
      `${root}/get_series?category_id=${enc}`,
      `${root}/get_series?cat_id=${enc}`,
      `${root}/get_series?category=${enc}`,
      `${root}/get_series/${enc}`,
      `${root}/player_api?action=get_series&category_id=${enc}`,
      `${root}/player_api.php?action=get_series&category_id=${enc}`,
    ];
  }

  function bulkSeriesUrls(): string[] {
    return [
      `${root}/series`,
      `${root}/get_series`,
      `${root}/player_api?action=get_series`,
      `${root}/player_api.php?action=get_series`,
    ];
  }

  let allSeries: LiveStream[] = [];

  /** Nodecast often exposes all series on `GET …/series` right after `series_categories` — try bulk before per-category `get_series`. */
  for (const url of bulkSeriesUrls()) {
    try {
      const payload = await fetchProxiedJsonWithInit<unknown>(url, { headers });
      const chunk = mapChunk(payload);
      if (chunk.length) {
        allSeries = chunk;
        break;
      }
    } catch {
      /* variante suivante */
    }
  }

  if (!allSeries.length && seriesCats.length > 0) {
    for (const cat of seriesCats) {
      for (const url of seriesUrlsForCategory(cat.category_id)) {
        try {
          const payload = await fetchProxiedJsonWithInit<unknown>(url, { headers });
          const chunk = mapChunk(payload, cat.category_id);
          if (chunk.length) {
            allSeries.push(...chunk);
            break;
          }
        } catch {
          /* variante suivante */
        }
      }
    }
  }

  if (!allSeries.length) {
    const fromFavorites = await loadSeriesCatalogFromFavoritesApi(base, sourceId, headers);
    if (fromFavorites) return fromFavorites;
    return null;
  }
  const categories = seriesCats.length ? seriesCats : categoriesFromStreams(allSeries);
  return { categories, streamsByCat: groupStreamsByCategory(allSeries) };
}

/** Favorites rows often wrap the Xtream row under `series` / `item` / etc. */
function unwrapFavoriteSeriesRow(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  const nestedKeys = [
    "series",
    "item",
    "content",
    "show",
    "program",
    "vod",
    "xtream",
    "xtream_series",
    "metadata",
  ] as const;
  for (const k of nestedKeys) {
    const v = o[k];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const inner = v as Record<string, unknown>;
    if (
      inner.name ||
      inner.title ||
      inner.series_name ||
      inner.series_id != null ||
      inner.seriesId != null
    ) {
      return { ...o, ...inner };
    }
  }
  if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
    const inner = o.data as Record<string, unknown>;
    if (inner.name || inner.title || inner.series_id != null) return { ...o, ...inner };
  }
  return raw;
}

/** Nodecast-style favorites list when Xtream `get_series` is empty (same auth as catalogue). */
async function loadSeriesCatalogFromFavoritesApi(
  base: string,
  sourceId: string,
  headers?: Record<string, string>
): Promise<{ categories: LiveCategory[]; streamsByCat: Map<string, LiveStream[]> } | null> {
  const root = base.replace(/\/+$/, "");
  const enc = encodeURIComponent(sourceId);
  const raw = import.meta.env.VITE_NODECAST_SERIES_FAVORITES_URL?.trim();
  const urls: string[] = [];
  if (raw) {
    urls.push(
      /^https?:\/\//i.test(raw)
        ? raw
        : `${root}${raw.startsWith("/") ? raw : `/${raw}`}`
    );
  } else {
    urls.push(`${root}/api/favorites?itemType=series`);
    urls.push(`${root}/api/favorites?itemType=series&sourceId=${enc}`);
    urls.push(`${root}/api/favorites?itemType=series&source_id=${enc}`);
    urls.push(`${root}/api/favorites?itemType=series&xtreamSourceId=${enc}`);
  }

  for (const url of urls) {
    try {
      const payload = await fetchProxiedJsonWithInit<unknown>(url, { headers });
      const arr = seriesListFromPayload(payload);
      const mapped = arr
        .map((item, idx) => mapNodecastSeriesToStream(unwrapFavoriteSeriesRow(item), idx, sourceId))
        .filter((s): s is LiveStream => s != null);
      if (mapped.length) {
        return {
          categories: categoriesFromStreams(mapped),
          streamsByCat: groupStreamsByCategory(mapped),
        };
      }
    } catch {
      /* try next URL */
    }
  }
  return null;
}

export async function tryNodecastLoginAndLoad(
  base: string,
  username: string,
  password: string
): Promise<NodecastCatalogLoadResult> {
  const loginCandidates = ["/api/auth/login", "/api/login", "/auth/login"];
  let loggedIn = false;
  let nodecastAuthHeaders: Record<string, string> | undefined;
  for (const path of loginCandidates) {
    try {
      const loginPayload = await fetchProxiedJsonWithInit<unknown>(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const token = extractTokenDeep(loginPayload);
      if (token) {
        nodecastAuthHeaders = { Authorization: `Bearer ${token}` };
      }
      loggedIn = true;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!loggedIn) {
    throw new Error("Nodecast login failed. Check panel credentials.");
  }

  const channelCandidates = [
    "/api/channels",
    "/api/live/channels",
    "/api/content/live",
    "/api/streams/live",
    "/api/tv/channels",
    "/api/content/channels",
    "/api/live",
  ];
  let streams: LiveStream[] = [];
  for (const path of channelCandidates) {
    try {
      const payload = await fetchProxiedJson<unknown>(`${base}${path}`);
      const arr = asArray(payload);
      const mapped = arr
        .map((item, idx) => mapNodecastChannelToLiveStream(item, idx))
        .filter((s): s is LiveStream => s != null);
      if (mapped.length) {
        streams = mapped;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!streams.length) {
    const discovered = await discoverXtreamSourceIdsInternal(base, nodecastAuthHeaders);
    const sourceIds = discovered.length ? discovered : ["9"];

    for (const sourceId of sourceIds) {
      try {
        const [catPayload, streamPayload] = await Promise.all([
          fetchProxiedJsonWithInit<unknown>(
            `${base}/api/proxy/xtream/${encodeURIComponent(sourceId)}/live_categories`,
            { headers: nodecastAuthHeaders }
          ),
          fetchProxiedJsonWithInit<unknown>(
            `${base}/api/proxy/xtream/${encodeURIComponent(sourceId)}/live_streams`,
            { headers: nodecastAuthHeaders }
          ),
        ]);
        const mappedStreams = asArray(streamPayload)
          .map((item, idx) => mapNodecastChannelToLiveStream(item, idx))
          .filter((s): s is LiveStream => s != null)
          .map((s) => ({ ...s, nodecast_source_id: sourceId }));
        if (!mappedStreams.length) continue;

        streams = mappedStreams;
        const mappedCats = asArray(catPayload)
          .map((c) => {
            if (!c || typeof c !== "object") return null;
            const o = c as Record<string, unknown>;
            const id = String(o.category_id ?? o.id ?? "").trim();
            const name = String(o.category_name ?? o.name ?? id).trim();
            if (!id) return null;
            return { category_id: id, category_name: name, parent_id: 0 } as LiveCategory;
          })
          .filter((c): c is LiveCategory => c != null);
        const categories = mappedCats.length ? mappedCats : categoriesFromStreams(streams);
        return {
          categories,
          streamsByCat: groupStreamsByCategory(streams),
          authHeaders: nodecastAuthHeaders,
          nodecastXtreamSourceId: sourceId,
          vodCategories: [],
          vodStreamsByCat: new Map(),
          seriesCategories: [],
          seriesStreamsByCat: new Map(),
        };
      } catch {
        // try next source id
      }
    }

    throw new Error("Connected to Nodecast but no channels endpoint returned stream URLs.");
  }

  const categories = categoriesFromStreams(streams);
  const discovered = await discoverXtreamSourceIdsInternal(base, nodecastAuthHeaders);
  const tryIds = discovered.length ? discovered : ["9"];
  const fromStream = streams.map((s) => s.nodecast_source_id?.trim()).find(Boolean);
  const nodecastXtreamSourceId = fromStream || tryIds[0];
  return {
    categories,
    streamsByCat: groupStreamsByCategory(streams),
    authHeaders: nodecastAuthHeaders,
    nodecastXtreamSourceId,
    vodCategories: [],
    vodStreamsByCat: new Map(),
    seriesCategories: [],
    seriesStreamsByCat: new Map(),
  };
}

function extractMovieDataBlob(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const r = payload as Record<string, unknown>;
  const md = r.movie_data;
  if (md && typeof md === "object" && !Array.isArray(md)) {
    return md as Record<string, unknown>;
  }
  const data = r.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const md2 = d.movie_data;
    if (md2 && typeof md2 === "object" && !Array.isArray(md2)) {
      return md2 as Record<string, unknown>;
    }
    return d;
  }
  return r;
}

function containerExtFromVodInfoPayload(payload: unknown): string | null {
  const blob = extractMovieDataBlob(payload);
  if (!blob) return null;
  const ext = String(blob.container_extension ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return ext || null;
}

/** Nodecast / Xtream proxy often returns `{ "error": "Unknown action" }` with HTTP 200. */
function xtreamProxyJsonLooksRejected(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const err = (payload as Record<string, unknown>).error;
  return typeof err === "string" && Boolean(err.trim());
}

function extractVodPlaybackHrefFromInfo(payload: unknown): string | null {
  const deep = extractStreamUrlDeep(payload);
  if (deep) return deep;
  const blob = extractMovieDataBlob(payload);
  if (!blob) return null;
  for (const k of [
    "direct_source",
    "stream_url",
    "movie_play_link",
    "iframe",
    "url",
    "hls_url",
    "playback_url",
  ]) {
    const v = blob[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return null;
}

async function resolvePlaybackHrefViaNodecast(
  nodecastBase: string,
  href: string,
  headers?: Record<string, string>
): Promise<string | null> {
  const trimmed = innermostHttpStreamTarget(href.trim());
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const b = nodecastBase.replace(/\/+$/, "");
  let nodeOrigin: string;
  try {
    nodeOrigin = new URL(b).origin;
  } catch {
    return null;
  }
  let extracted: URL;
  try {
    extracted = new URL(trimmed);
  } catch {
    return null;
  }
  if (extracted.origin === nodeOrigin) {
    return resolveCandidateToPlayableUrl(extracted.href, headers);
  }
  const viaProxy = buildNodecastProxyStreamPlaylistUrl(b, extracted.href);
  const progressive = hrefLooksLikeProgressiveContainer(extracted.href);
  /* MKV/MP4 through Nodecast /api/proxy/stream often 500s (CDN terminate, incompatible codecs).
     Prefer transcode first for file containers; never return viaProxy after both paths fail
     (that would replay the same broken URL in <video>). */
  if (progressive) {
    const transcodedFirst = await createNodecastTranscodeUrl(b, extracted.href, headers);
    if (transcodedFirst) return transcodedFirst;
    return resolveCandidateToPlayableUrl(viaProxy, headers);
  }
  const proxiedPlayable = await resolveCandidateToPlayableUrl(viaProxy, headers);
  if (proxiedPlayable) return proxiedPlayable;
  return createNodecastTranscodeUrl(b, extracted.href, headers);
}

async function tryResolveVodFromGetInfo(
  b: string,
  sid: string,
  streamId: string,
  s: LiveStream,
  headers?: Record<string, string>
): Promise<string | null> {
  const infoUrls = [
    `${b}/api/proxy/xtream/${sid}/player_api?action=get_vod_info&vod_id=${streamId}`,
    `${b}/api/proxy/xtream/${sid}/player_api.php?action=get_vod_info&vod_id=${streamId}`,
  ];
  for (const u of infoUrls) {
    try {
      const payload = await fetchProxiedJsonWithInit<unknown>(u, { headers });
      if (xtreamProxyJsonLooksRejected(payload)) continue;
      const href = extractVodPlaybackHrefFromInfo(payload);
      if (href) {
        const r = await resolvePlaybackHrefViaNodecast(b, href, headers);
        if (r) return r;
      }
      const extFromPayload = containerExtFromVodInfoPayload(payload);
      const ext =
        (extFromPayload && /^[a-z0-9]+$/i.test(extFromPayload)
          ? extFromPayload.toLowerCase()
          : null) ??
        (s.container_extension && /^[a-z0-9]+$/i.test(s.container_extension)
          ? s.container_extension.toLowerCase()
          : null);
      if (ext) {
        const byExt = [
          `${b}/api/proxy/xtream/${sid}/stream/${streamId}/movie?container=${ext}`,
          `${b}/api/proxy/xtream/${sid}/stream/${streamId}/vod?container=${ext}`,
          `${b}/api/proxy/xtream/${sid}/movie/${streamId}.${ext}`,
          `${b}/api/proxy/xtream/${sid}/vod/${streamId}.${ext}`,
        ];
        for (const c of byExt) {
          const playable = await resolveCandidateToPlayableUrl(c, headers);
          if (playable) return playable;
        }
      }
    } catch {
      /* try next URL */
    }
  }
  return null;
}

export async function resolveNodecastStreamUrl(
  base: string,
  s: LiveStream,
  authHeaders?: Record<string, string>
): Promise<string | null> {
  if (s.nodecast_source_id) {
    const sid = encodeURIComponent(s.nodecast_source_id);
    const streamId = encodeURIComponent(String(s.stream_id));
    const proxyXtreamCandidates = [
      `${base}/api/proxy/xtream/${sid}/stream/${streamId}/live?container=m3u8`,
      `${base}/api/proxy/xtream/${sid}/stream/${streamId}/live?container=ts`,
      `${base}/api/proxy/xtream/${sid}/stream/${streamId}`,
      `${base}/api/proxy/xtream/${sid}/live/${streamId}.m3u8`,
    ];
    for (const candidate of proxyXtreamCandidates) {
      const playable = await resolveCandidateToPlayableUrl(candidate, authHeaders);
      if (playable) return playable;
    }
    return null;
  }
  const id = (s.nodecast_channel_id ?? "").trim();
  if (!id) return null;

  const candidates = [
    `/api/channels/${encodeURIComponent(id)}/stream`,
    `/api/channels/${encodeURIComponent(id)}/play`,
    `/api/live/channels/${encodeURIComponent(id)}/stream`,
    `/api/stream/${encodeURIComponent(id)}`,
    `/stream/${encodeURIComponent(id)}`,
  ];

  for (const p of candidates) {
    try {
      const payload = await fetchProxiedJsonWithInit<unknown>(`${base}${p}`, {
        headers: authHeaders,
      });
      const url = extractStreamUrlDeep(payload);
      if (url) return url;
    } catch {
      // try next endpoint
    }
  }
  return null;
}

export async function resolveNodecastVodStreamUrl(
  base: string,
  s: LiveStream,
  authHeaders?: Record<string, string>
): Promise<string | null> {
  const rawSid = (s.nodecast_source_id ?? "").trim();
  if (!rawSid) return null;
  const b = base.replace(/\/+$/, "");
  const sid = encodeURIComponent(rawSid);
  const streamId = encodeURIComponent(String(s.stream_id));

  const ds = (s.direct_source ?? "").trim();
  if (ds && /^https?:\/\//i.test(ds)) {
    const fromDirect = await resolvePlaybackHrefViaNodecast(b, ds, authHeaders);
    if (fromDirect) return fromDirect;
  }

  const candidates: string[] = [];
  const ext = (s.container_extension ?? "").trim().toLowerCase();
  if (ext && /^[a-z0-9]+$/.test(ext)) {
    candidates.push(
      `${b}/api/proxy/xtream/${sid}/stream/${streamId}/movie?container=${ext}`,
      `${b}/api/proxy/xtream/${sid}/stream/${streamId}/vod?container=${ext}`,
      `${b}/api/proxy/xtream/${sid}/movie/${streamId}.${ext}`,
      `${b}/api/proxy/xtream/${sid}/vod/${streamId}.${ext}`,
      `${b}/api/proxy/xtream/${sid}/movie/${streamId}.${ext}?container=m3u8`
    );
  }
  const streamContainers = ["m3u8", "mp4", "mkv", "ts"] as const;
  for (const c of streamContainers) {
    candidates.push(
      `${b}/api/proxy/xtream/${sid}/stream/${streamId}/movie?container=${c}`,
      `${b}/api/proxy/xtream/${sid}/stream/${streamId}/vod?container=${c}`
    );
  }
  candidates.push(
    `${b}/api/proxy/xtream/${sid}/stream/${streamId}/movie`,
    `${b}/api/proxy/xtream/${sid}/stream/${streamId}/vod`,
    `${b}/api/proxy/xtream/${sid}/vod/${streamId}.m3u8`,
    `${b}/api/proxy/xtream/${sid}/vod/${streamId}.ts`,
    `${b}/api/proxy/xtream/${sid}/movie/${streamId}`,
    `${b}/api/proxy/xtream/${sid}/movie/${streamId}.m3u8`,
    `${b}/api/proxy/xtream/${sid}/movie/${streamId}.mp4`,
    `${b}/api/proxy/xtream/${sid}/play/${streamId}`,
    `${b}/api/proxy/xtream/${sid}/stream/${streamId}`
  );
  for (const candidate of candidates) {
    const playable = await resolveCandidateToPlayableUrl(candidate, authHeaders);
    if (playable) return playable;
  }
  return tryResolveVodFromGetInfo(b, sid, streamId, s, authHeaders);
}

function extractFirstEpisodeStreamId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  const eps = data.episodes;
  if (eps && typeof eps === "object" && !Array.isArray(eps)) {
    const seasonKeys = Object.keys(eps).sort((a, b) => Number(a) - Number(b));
    for (const sk of seasonKeys) {
      const arr = (eps as Record<string, unknown>)[sk];
      if (!Array.isArray(arr)) continue;
      for (const ep of arr) {
        if (!ep || typeof ep !== "object") continue;
        const e = ep as Record<string, unknown>;
        const sid = Number(e.stream_id ?? e.id);
        if (Number.isFinite(sid) && sid > 0) return sid;
      }
    }
  }
  return null;
}

/** Resolve first playable episode for a Xtream series (get_series_info → VOD stream). */
export async function resolveNodecastSeriesPlayableUrl(
  base: string,
  seriesId: number,
  sourceId: string,
  authHeaders?: Record<string, string>
): Promise<string | null> {
  const b = base.replace(/\/+$/, "");
  const sid = encodeURIComponent(sourceId);
  const seriesQ = encodeURIComponent(String(seriesId));
  const infoUrls = [
    `${b}/api/proxy/xtream/${sid}/player_api?action=get_series_info&series_id=${seriesQ}`,
    `${b}/api/proxy/xtream/${sid}/player_api.php?action=get_series_info&series_id=${seriesQ}`,
  ];
  for (const u of infoUrls) {
    try {
      const payload = await fetchProxiedJsonWithInit<unknown>(u, { headers: authHeaders });
      if (xtreamProxyJsonLooksRejected(payload)) continue;
      const epId = extractFirstEpisodeStreamId(payload);
      if (epId == null) continue;
      const epStream: LiveStream = {
        stream_id: epId,
        name: "Episode",
        nodecast_source_id: sourceId,
        nodecast_media: "vod",
      };
      return resolveNodecastVodStreamUrl(base, epStream, authHeaders);
    } catch {
      /* try next URL */
    }
  }
  return null;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
